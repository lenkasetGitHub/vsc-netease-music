const fs = require('fs')
const path = require('path')
const events = require('events')
const vscode = require('vscode')

const ActiveEditor = () => {
	let activeTextEditor = vscode.window.activeTextEditor
	return {
		reveal: () => activeTextEditor ? vscode.window.showTextDocument(activeTextEditor.document, activeTextEditor.viewColumn, false) : undefined
	}
}

const GlobalStorage = context => {
	return {
		get: key => JSON.parse(context.globalState.get(key) || 'null'),
		set: (key, value) => context.globalState.update(key, JSON.stringify(value))
	}
}

const PreferenceReader = context => {
	let preference = {}
	return {
		get: key => key in preference ? preference[key] : preference[key] = vscode.workspace.getConfiguration().get(`NeteaseMusic.${key}`),
		dispose: () => preference = null
	}
}

const StateManager = context => {
	let state = {}
	return {
		get: key => state[key],
		set: (key, value) => vscode.commands.executeCommand('setContext', `neteasemusic.${key}`, state[key] = value),
		dispose: () => (Object.keys(state).forEach(key => vscode.commands.executeCommand('setContext', `neteasemusic.${key}`, undefined)), state = null)
	}
}

const PlayerBar = context => {
	const buttons = {
		previous: {
			command: 'neteasemusic.previous',
			icon: '$(chevron-left)',
			title: '上一首'
		},
		next: {
			command: 'neteasemusic.next',
			icon: '$(chevron-right)',
			title: '下一首'
		},
		repeat: {
			command: 'neteasemusic.mode.loop',
			icon: '$(sync)',
			title: '播放模式: 循环播放',
			state: {mode: 0}
		},
		random: {
			command: 'neteasemusic.mode.repeat',
			icon: '$(pin)',
			title: '播放模式: 单曲循环',
			state: {mode: 1}
		},
		intelligent: { // action to intelligent or loop
			command: 'neteasemusic.mode.random',
			icon: '$(question)',
			title: '播放模式: 随机播放',
			state: {mode: 2}
		},
		loop: {
			command: 'neteasemusic.mode.intelligent',
			icon: '$(pulse)',
			title: '播放模式: 心动模式',
			state: {mode: 3}
		},
		play: {
			command: 'neteasemusic.play',
			// icon: '▶'
			icon: '$(play)',
			title: '播放',
			state: {playing: false}
		},
		pause: {
			command: 'neteasemusic.pause',
			// icon: ' ❚❚ '
			icon: '$(primitive-square)',
			title: '暂停',
			state: {playing: true}
		},
		like: {
			command: 'neteasemusic.like',
			icon: '$(heart)',
			title: '红心',
			color: 'rgba(255,255,255,0.5)',
			state: {liked: false}
		},
		dislike: {
			command: 'neteasemusic.dislike',
			icon: '$(heart)',
			title: '取消红心',
			state: {liked: true}
		},
		mute: {
			command: 'neteasemusic.mute',
			icon: '$(unmute)',
			title: '静音',
			state: {muted: false}
		},
		unmute: {
			command: 'neteasemusic.unmute',
			icon: '$(mute)',
			title: '取消静音',
			color: 'rgba(255,255,255,0.5)',
			state: {muted: true}
		},
		volume: {
			command: 'neteasemusic.volume',
			icon: '100',
			title: '音量调节'
		},
		list: {
			command: 'neteasemusic.list',
			icon: ''
		},
		more: {
			command: 'neteasemusic.more',
			icon: '$(kebab-horizontal)',
			title: '更多操作'
		}
	}

	const attach = (item, button) => {
		item.color = button.color || undefined
		item.text = button.icon
		item.command = button.command
		item.tooltip = button.title || undefined
		if (button.state) Object.entries(button.state).forEach(entry => runtime.stateManager.set.apply(null, entry))
	}

	const order = [['list'], ['like', 'dislike'], ['previous'], ['play', 'pause'], ['next'], ['repeat', 'random', 'intelligent', 'loop'], ['mute', 'unmute'], ['volume'], ['more']].reverse()

	const items = order.map((group, index) => {
		group.forEach(name => buttons[name].index = index)
		let item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 163 + index)
		attach(item, buttons[group[0]])
		return item
	})

	return {
		dispose: () => items.forEach(item => item.dispose()),
		state: state => {
			if (!(state in buttons)) return
			if (state.includes('like')) (api.user.account() && !runtime.stateManager.get('program')) ? items[buttons.like.index].show() : items[buttons.like.index].hide()
			let index = buttons[state].index
			let name = order[index][(order[index].indexOf(state) + 1) % order[index].length]
			attach(items[index], buttons[name])
		},
		update: text => {
			items[buttons.list.index].text = text
		},
		volume: state => {
			attach(items[buttons.mute.index], buttons[(state.muted ? 'unmute' : 'mute')])
			items[buttons.volume.index].color = items[buttons.mute.index].color
			items[buttons.volume.index].text = `${state.value.toFixed(2) * 100}`
		},
		show: radio => {
			runtime.stateManager.set('track', true)
			items.forEach(item => item.show())
			if (radio) ['previous', 'repeat'].map(name => buttons[name].index).forEach(index => items[index].hide())
		},
		hide: () => {
			runtime.stateManager.set('track', false)
			items.forEach(item => item.hide())
		}
	}
}

const DuplexChannel = context => {
	let activeEditor = ActiveEditor()

	const logger = song => {
		const translation = {'playlist': 'list', 'artist': 'artist', 'album': 'album'}
		const output = {
			id: song.id,
			type: 'song',
			wifi: 0,
			download: 0,
			time: parseInt(song.duration),
			end: (runtime.stateManager.get('mode') == 1 ? 'playend' : 'ui')
		}
		if (translation[song.source.type]) {
			output.source = translation[song.source.type]
			output.sourceid = song.source.id
		}
		return output
	}

	/**
	 * Websocket
	 */
	// const server = new (require('ws')).Server({port: 16363, host: '127.0.0.1'})
	// const connection = new Promise(resolve => server.once('connection', connection => resolve(connection)))
	// connection.then(webSocket => webSocket.on('message', receiveMessage))
	// const postMessage = (command, data) => connection.then(webSocket => webSocket.send(JSON.stringify({command, data})))

	/**
	 * Long Polling
	 */
	// const caller = new events.EventEmitter()
	// const queue = []

	// const server = require('http').createServer((req, res) => {
	// 	if (req.url != '/') return
	// 	new Promise(resolve => {
	// 		let timer
	// 		if (queue.length > 0) return resolve(queue.shift())
	// 		const shift = () => {
	// 			caller.removeListener('message', shift)
	// 			clearTimeout(timer)
	// 			resolve(queue.shift())
	// 		}
	// 		caller.once('message', shift)
	// 		timer = setTimeout(shift, 5000)
	// 	})
	// 	.then(message => {
	// 		res.writeHead(message ? 200 : 204, {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'})
	// 		res.end(message ? JSON.stringify(message) : undefined)
	// 	})
	// })
	// .listen(16363, '127.0.0.1')
	// const postMessage = (command, data) => (queue.push({command, data}), caller.emit('message'))

	/**
	 * Server-Sent Events
	 */
	// const caller = new events.EventEmitter()
	// const server = require('http').createServer().listen(16363, '127.0.0.1')
	// server.on('request', (req, res) => {
	// 	if (req.url === '/sender') {
	// 		res.writeHead(200, {'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*'}), res.write(': \n\n')
	// 		const listener = message => res.write('data: ' + JSON.stringify(message) + '\n\n')
	// 		caller.on('message', listener)
	// 		res.once('close', () => caller.removeListener('message', listener))
	// 	}
	// 	else if (req.url === '/receiver') {
	// 		new Promise((resolve, reject) => {
	// 			let chunks = []
	// 			req
	// 			.on('data', chunk => chunks.push(chunk))
	// 			.on('end', () => resolve(Buffer.concat(chunks).toString()))
	// 			.on('error', error => reject(error))
	// 		})
	// 		.then(receiveMessage)
	// 		.then(() => 204).catch(() => 400)
	// 		.then(code => (res.writeHead(code, {'Access-Control-Allow-Origin': '*'}), res.end()))
	// 	}
	// })
	// const postMessage = (command, data) => caller.emit('message', {command, data})

	const receiveMessage = message => {
		message = typeof(message) === 'object' ? message : JSON.parse(message)
		const {type, body} = message
		if (type == 'event') {
			if (body.name == 'ready') {
				runtime.event.emit('ready')
				activeEditor.reveal()
				activeEditor = null
			}
			else if (body.name == 'end') {
				controller.next(true)
				let song = body.data
				if (song.source.type != 'djradio') api.song.log(logger(song))
			}
			else if (body.name == 'load') {
				let song = body.data
				let program = song.source.type === 'djradio'
				let artist = interaction.utility.stringify.artist(song)
				let album = song.album.name
				let playing = [program ? album : artist, song.name].join(' - ')
				vscode.window.showInformationMessage(`正在播放: ${playing}`)
				runtime.playerBar.update(playing)
				if (song.source.type == 'djradio') api.program.listen(song.id)
			}
			else if (body.name == 'lyric') {
				runtime.playerBar.update(body.data)
			}
			else if (body.name == 'volume') {
				runtime.playerBar.volume(body.data)
				runtime.globalStorage.set('muted', body.data.muted)
				runtime.globalStorage.set('volume', body.data.value)
			}
			else if (['play', 'pause'].includes(body.name)) {
				runtime.playerBar.state(body.name)
			}
			else if (body.name == 'error') {
				vscode.window.showWarningMessage(`无法播放: ${interaction.utility.stringify.song(body.data)}`)
				controller.remove()
				controller.play()
			}
		}
		else if (type == 'command') {
			controller[body.action]()
		}
		else if (type == 'echo') {
			vscode.window.showInformationMessage(body.toString())
		}
	}

	const postMessage = (command, data) => runtime.webviewPanel.panel.postMessage({command, data})
	runtime.webviewPanel.panel.webview.onDidReceiveMessage(receiveMessage, undefined, context.subscriptions)

	return {
		// dispose: () => server.close(),
		postMessage,
		receiveMessage
	}
}

const AssistServer = context => {
	const urlParse = require('url').parse
	const queryify = require('querystring').stringify
	const queryParse = require('querystring').parse

	const server = require('http').createServer()
	.on('request', (req, res) => {
		if (req.method === 'option') return res.end()
		const url = urlParse(req.url)
		const query = queryParse(url.query)
		const headers = Object.assign({}, req.headers)
		
		const [, type, id] = (url.pathname.match(/^\/(song|program)\/(\d+)$/) || [])
		if (id) {
			['host', 'referer'].filter(key => key in headers).forEach(key => delete headers[key])
			Promise.resolve(query.url ? api.request('GET', query.url, headers) : Promise.reject(new Error('initial')))
			.then(response => response.statusCode.toString().startsWith('20') ? response : Promise.reject(new Error('expire')))
			.then(response => (res.writeHead(response.statusCode, response.headers), response.pipe(res), Promise.reject(new Error('end'))))
			.catch(error => ['initial', 'expire'].includes(error.message) ? api[type].url(id) : error)
			.then(body => body.data[0].url ? body.data[0].url : Promise.reject(new Error('empty')))
			.then(link => runtime.preferenceReader.get('CDN.redirect') ? link.replace(/(m\d+?)(?!c)\.music\.126\.net/, '$1c.music.126.net') : link)
			.then(link => (res.writeHead(302, {location: url.pathname + '?' + queryify({url: link})}), res.end()))
			.catch(error => ['empty'].includes(error.message) ? (res.writeHead(404, {'content-type': 'audio/*'}), res.end()) : error)
		}
		else if (url.pathname === '/song/file' && query.path) {
			let file = decodeURIComponent(urlParse(query.path).pathname), meta = {}
			file = process.platform === 'win32' ? file.replace(/^\//, '') : file
			try {meta = fs.statSync(file)} 
			catch(error) {return (res.writeHead(404, {'content-type': 'audio/*'}), res.end())}
			let [start, end] = (headers['range'] || '').split('-')
			start = parseInt(start) || 0
			end = parseInt(end) || Infinity
			const bytes = `bytes ${start}-${end === Infinity ? meta.size - 1 : end}/${meta.size}`
			res.writeHead(headers['range'] ? 206 : 200, {'content-type': 'audio/*', 'content-range': headers['range'] ? bytes : null})
			fs.createReadStream(file, {start, end}).pipe(res)
		}
		else {
			res.socket.destroy()
		}
	})
	.listen(16363, '127.0.0.1')

	return {
		dispose: () => server.close()
	}
}

const WebviewPanel = context => {
	// const panel = vscode.env.openExternal(vscode.Uri.file(path.join(context.extensionPath, 'index.html')))
	const panel = vscode.window.createWebviewPanel(
		'neteasemusic', 'NeteaseMusic',
		{preserveFocus: true, viewColumn: vscode.ViewColumn.One},
		{enableScripts: true, retainContextWhenHidden: true, portMapping: [{webviewPort: 16363, extensionHostPort: 16363}]}
	)
	panel.iconPath = ['light', 'dark'].reduce((uri, theme) => Object.assign(uri, {[theme]: vscode.Uri.file(path.join(context.extensionPath, `${theme}.svg`))}), {})
	panel.webview.html =
		fs.readFileSync(vscode.Uri.file(path.join(context.extensionPath, 'index.html')).fsPath, 'utf-8')
		.replace('<base>', `<base href="${panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, '/')))}">`)

	// panel.webview.onDidReceiveMessage(runtime.duplexChannel.receiveMessage, undefined, context.subscriptions)
	panel.onDidDispose(() => runtime.event.emit('suspend'), null, context.subscriptions)

	return {
		panel,
		dispose: () => panel.dispose()
	}
}

const CommandManager = context => {
	const commands = {
		'toplist': interaction.toplist,
		'playlist.highquality': interaction.playlist.highquality,
		'playlist.hot': interaction.playlist.hot,
		'new.song': interaction.new.song,
		'new.album': interaction.new.album,
		'search': interaction.search,

		'user.playlist': interaction.user.playlist,
		'user.artist': interaction.user.artist,
		'user.album': interaction.user.album,
		'user.djradio': interaction.user.djradio,
		'user.record': interaction.user.record,
		'recommend.song': interaction.recommend.song,
		'recommend.playlist': interaction.recommend.playlist,
		'recommend.radio': interaction.recommend.radio,

		'login': interaction.login,
		'login.cookie': interaction.clone,
		'logout': interaction.logout,
		'sign': interaction.sign,

		'more': interaction.more,
		'list': interaction.list.show,
		'list.edit': interaction.list.edit,
		'play': controller.resume,
		'pause': controller.pause,
		'previous': controller.previous,
		'next': controller.next,

		'like': controller.like,
		'dislike': controller.dislike,

		'mute': controller.mute,
		'unmute': controller.unmute,
		'volume': controller.volumeChange,

		'auto.mute.unmute': () => controller[runtime.stateManager.get('muted') ? 'unmute' : 'mute'](),
		'auto.play.pause': () => controller[runtime.stateManager.get('playing') ? 'pause' : 'resume'](),

		'mode.loop': () => controller.mode(1),
		'mode.repeat': () => controller.mode(2),
		'mode.random': () => controller.mode(controller.favorite() ? 3 : 0),
		'mode.intelligent': () => controller.mode(0)
	}

	const registration = Object.keys(commands).map(name => vscode.commands.registerCommand(`neteasemusic.${name}`, commands[name]))
	registration.forEach(command => context.subscriptions.push(command))

	return {
		execute: name => name in commands ? commands[name].call() : null,
		dispose: () => registration.forEach(command => command.dispose())
	}
}

const runtime = {
	event: null,
	stateManager: null,
	globalStorage: null,
	preferenceReader: null,
	playerBar: null,
	assistServer: null,
	webviewPanel: null,
	duplexChannel: null,
	commandManager: null,
	dispose: () => {
		Object.keys(runtime).filter(key => typeof runtime[key] != 'function' && runtime[key])
		.forEach(key => {
			if (typeof runtime[key].dispose === 'function') runtime[key].dispose()
			runtime[key] = null
		})
	},
	activate: context => {
		if (runtime.webviewPanel) return

		runtime.event = new events.EventEmitter()
		runtime.stateManager = StateManager(context)
		runtime.globalStorage = GlobalStorage(context)
		runtime.preferenceReader = PreferenceReader(context)
		runtime.playerBar = PlayerBar(context)
		// runtime.duplexChannel = DuplexChannel(context)
		runtime.assistServer = AssistServer(context)
		runtime.webviewPanel = WebviewPanel(context)
		runtime.duplexChannel = DuplexChannel(context)
		runtime.commandManager = CommandManager(context)

		process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = runtime.preferenceReader.get('SSL.strict') ? undefined : 0

		runtime.event.once('ready', () =>
			Promise.all([api, controller].map(component => component.refresh()))
			.then(() => controller.restore())
			.then(() => runtime.stateManager.set('on', true))
		)
		runtime.event.once('suspend', () => runtime.dispose())
	}
}

module.exports = runtime
const api = require('./request.js')
const controller = require('./controller.js')
const interaction = require('./interaction.js')