const assert = require('node:assert/strict')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const zlib = require('node:zlib')
const { loadArkts, util } = require('./arkts-source.cjs')
const shellRoutes = loadArkts(
  'navigation/ShellRoute.ets',
  ['desktopPath', 'shellRouterParams', 'readShellRoute', 'sessionOpenParam'],
  { bundleCompat: require('../../entry/src/main/ets/vendor/bundle-compat.js') }
)
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')

const bytes = loadArkts(
  'transport/crypto/Bytes.ets',
  ['base64Encode', 'base64Decode', 'utf8Encode', 'utf8Decode'],
  { util }
)
const hostId = 'a'.repeat(32)
const meta = { id: hostId, name: 'Test host', endpoint: 'ws://test', publicKeyB64: 'key' }
const manifest = {
  buildId: 'build',
  routes: [
    {
      pathname: '/h/[hostId]',
      canOwnHostArea: true,
      canOwnHostAreaAcrossLayouts: true,
      grants: ['storage', 'navigate'],
      optionalGrants: []
    }
  ]
}
const connect = (client) => client.connect('ws://test', 'synthetic-token', 'key', 'v2')
const post = (bridge, frame) => bridge.onClientMessage(JSON.stringify({ v: 1, ...frame }))
function createController() {
  const replies = []
  return {
    replies,
    runJavaScript(script) {
      replies.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
}

test('a measured cutout and single crossing hinge reach the page and clear when the window moves', () => {
  const { projectPageRegions } = loadArkts('webshell/WindowRegions.ets', ['projectPageRegions'])
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const controller = createController()
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    controller,
    manifest,
    meta,
    `/h/${hostId}`
  )
  const regions = {
    occlusions: [{ x: 25, y: 4, width: 40, height: 28 }],
    creases: [{ x: 322, y: 0, width: 18, height: 640 }]
  }
  const send = (frame) => {
    const page = projectPageRegions(regions, frame)
    bridge.setPageGeometry({ occlusions: page.occlusions, sideRail: false }, page.division)
  }
  send({ x: 40, y: 20, width: 560, height: 580 })
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  assert.deepEqual(controller.replies.at(-1).pageGeometry.occlusions, [
    { x: 0, y: 0, width: 25, height: 12 }
  ])
  assert.deepEqual(controller.replies.at(-1).foldDivision, {
    axis: 'vertical',
    start: 282,
    end: 300
  })
  send({ x: 345, y: 20, width: 255, height: 580 })
  assert.deepEqual(controller.replies.at(-1).pageGeometry.occlusions, [])
  assert.equal(controller.replies.at(-1).foldDivision, null)
  bridge.dispose()
})

test('a terminal rail press is scoped to its visible page, active input owner and connected transport', async () => {
  const contract = loadArkts('webshell/TerminalRailClaim.ets', [
    'parseTerminalRailClaim',
    'terminalRailKeyEnabled',
    'terminalRailKeys',
    'TERMINAL_RAIL_ARROWS'
  ])
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], {
    ...peer,
    ...bytes,
    ...contract
  })
  const controller = createController()
  const host = `/h/${hostId}`
  const terminal = `${host}/session/worktree-a`
  const railManifest = {
    ...manifest,
    routes: [
      ...manifest.routes,
      {
        pathname: '/h/[hostId]/session/[worktreeId]',
        grants: ['navigate'],
        optionalGrants: ['terminalKeyRail']
      }
    ]
  }
  const bridge = new BridgeHost(new peer.SpikeRpcClient(), controller, railManifest, meta, host)
  const claims = []
  bridge.setTerminalRailClaimSink((claim) => claims.push(claim))
  bridge.setTerminalRailFocus(true)
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  const toolbar = {
    canSend: true,
    canCompose: false,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: true,
    runsAgent: false,
    modifiers: { ctrl: 'off', alt: 'off', shift: 'off' }
  }
  const claim = (owner) =>
    post(bridge, {
      type: 'notify',
      name: 'terminal-key-rail-claim',
      claimed: true,
      inputOwner: owner,
      toolbar
    })
  claim('pane-a')
  assert.equal(await bridge.sendTerminalRailKey('pane-a', 'arrowUp'), false)
  post(bridge, { type: 'notify', name: 'location', href: terminal })
  assert.equal(claims.at(-1)?.owner, 'pane-a')
  bridge.setPageGeometry({ occlusions: [], sideRail: true }, null, ['arrowUp', 'moreKeys'])
  assert.equal(await bridge.sendTerminalRailKey('pane-a', 'arrowUp'), true)
  assert.deepEqual(controller.replies.at(-1), {
    v: 1,
    type: 'terminalKey',
    inputOwner: 'pane-a',
    key: 'arrowUp'
  })
  claim('pane-b')
  assert.equal(await bridge.sendTerminalRailKey('pane-a', 'arrowUp'), false)
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'enter'), false)
  bridge.setTerminalRailFocus(false)
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'arrowUp'), false)
  bridge.setTerminalRailFocus(true)
  bridge.suspendTransport(1)
  assert.equal(claims.at(-1), null)
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'arrowUp'), false)
  bridge.attachTransport(new peer.SpikeRpcClient(), 'lan')
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'arrowUp'), false)
  claim('pane-b')
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'arrowUp'), true)
  post(bridge, { type: 'notify', name: 'location', href: host })
  assert.equal(claims.at(-1), null)
  assert.equal(await bridge.sendTerminalRailKey('pane-b', 'arrowUp'), false)
  bridge.dispose()
})

test('a drawable side strip clips above the keyboard and disappears when outside the window', () => {
  const terminalRail = require('../../entry/src/main/ets/vendor/terminal-rail.js')
  const { projectSideRail } = loadArkts('webshell/WindowRegions.ets', ['projectSideRail'], {
    terminalRail
  })
  const regions = {
    occlusions: [],
    creases: [],
    rail: { side: 'right', region: { x: 316, y: 64, width: 84, height: 600 } }
  }
  const frame = { x: 0, y: 32, width: 400, height: 660 }
  const clipped = projectSideRail(regions, frame, 400)
  assert.equal(clipped.height, 336)
  assert.equal(clipped.bottom, 292)
  assert.equal(projectSideRail(regions, frame, 60), null)
  assert.equal(projectSideRail(regions, { ...frame, width: 316 }), null)
})

test('a system status column can reserve a side strip while a camera cutout alone cannot', async () => {
  const terminalRail = require('../../entry/src/main/ets/vendor/terminal-rail.js')
  const empty = { left: 0, top: 0, width: 0, height: 0 }
  const avoid = { leftRect: empty, rightRect: empty, topRect: empty, bottomRect: empty }
  const cutout = { left: 948, top: 198, width: 252, height: 141 }
  let status = { ...avoid, topRect: { left: 948, top: 0, width: 252, height: 174 } }
  let observed
  const { ShellWindowRegions } = loadArkts('webshell/WindowRegions.ets', ['ShellWindowRegions'], {
    terminalRail,
    window: { AvoidAreaType: { TYPE_SYSTEM: 0, TYPE_KEYBOARD: 3, TYPE_NAVIGATION_INDICATOR: 4 } },
    display: {
      on() {},
      off() {},
      isFoldable: () => false,
      convertGlobalToRelativeCoordinate: () => ({ displayId: 0, position: { x: 0, y: 0 } }),
      getDisplayByIdSync: () => ({ getCutoutInfo: async () => ({ boundingRects: [cutout] }) })
    },
    AppStorage: { setOrCreate: (_key, value) => observed?.(JSON.parse(value || 'null')) }
  })
  const regions = new ShellWindowRegions({
    on() {},
    off() {},
    getWindowProperties: () => ({ windowRect: { ...empty, width: 1200, height: 2400 } }),
    getUIContext: () => ({ px2vp: (pixels) => pixels / 3 }),
    getWindowAvoidArea: (type) => (type === 0 ? status : avoid)
  })
  let next = new Promise((resolve) => {
    observed = resolve
  })
  regions.start()
  let state = await next
  assert.equal(state.rail.side, 'right')
  assert.equal(state.rail.region.width, 84)
  assert.equal(state.rail.region.y, 113)
  status = { ...avoid, topRect: { left: 0, top: 0, width: 1200, height: 60 } }
  next = new Promise((resolve) => {
    observed = resolve
  })
  regions.refresh()
  state = await next
  assert.equal(state.rail, null)
  regions.dispose()
})

test('closing during handshake rejects the connection', async () => {
  const peer = createRpcPeer({ authenticate: false })
  const client = new peer.SpikeRpcClient()
  const pending = assert.rejects(connect(client), /socket closed/)
  peer.close()
  await pending
})

test('a silent handshake ends at its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer({ authenticate: false })
  const client = new peer.SpikeRpcClient()
  const pending = assert.rejects(connect(client), /连接超时/)
  t.mock.timers.tick(10000)
  await pending
})

test('an unanswered RPC returns a delivery-unknown timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await connect(client)
  const pending = client.request('worktree.create', '{"name":"test"}')
  t.mock.timers.tick(15000)
  const response = await pending
  assert.equal(response.errorCode, 'timeout')
  assert.match(response.errorMessage, /delivery may have occurred/)
  client.close()
})

test('an asynchronous transport send failure ends the request', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await connect(client)
  peer.failSend()
  assert.equal((await client.request('status.get', null)).errorCode, 'closed')
})

test('compressed binary reaches the public frame listener as plaintext', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  client.setFflate(require('../../entry/src/main/ets/vendor/fflate-umd.js'))
  await connect(client)
  const payload = Buffer.from('terminal output')
  const wrapper = Buffer.alloc(6)
  wrapper.set([0x7a, 2])
  wrapper.writeUInt32LE(15, 2)
  const received = new Promise((resolve) => client.onBinaryFrames(resolve))
  peer.receiveBinary(Buffer.concat([wrapper, zlib.gzipSync(payload)]))
  assert.deepEqual(Buffer.from(await received), Buffer.from('terminal output'))
  client.close()
})

test('bridge request and subscription preserve execution-host routing and protect credentials', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await connect(client)
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const bridge = new BridgeHost(client, createController(), manifest, meta, `/h/${hostId}`)
  post(bridge, {
    type: 'request',
    id: 'request',
    method: 'worktree.ps',
    envelope: { executionHost: 'runtime:vm', deviceToken: 'forged' }
  })
  post(bridge, {
    type: 'subscribe',
    id: 'subscription',
    method: 'session.tabs.subscribeAll',
    envelope: { executionHost: 'runtime:vm', id: 'forged' }
  })
  const [request, subscription] = peer.sent.map(JSON.parse)
  assert.equal(request.executionHost, 'runtime:vm')
  assert.equal(request.deviceToken, 'synthetic-token')
  assert.equal(subscription.executionHost, 'runtime:vm')
  bridge.dispose()
  client.close()
})

test('a draft written through the bridge survives reopening', () => {
  const stores = new Map()
  const preferences = {
    getPreferencesSync: (_context, { name }) => {
      if (!stores.has(name)) {
        stores.set(name, new Map())
      }
      const values = stores.get(name)
      return {
        getSync: (key, fallback) => values.get(key) ?? fallback,
        putSync: (key, value) => values.set(key, value),
        hasSync: (key) => values.has(key),
        deleteSync: (key) => values.delete(key),
        flushSync() {}
      }
    }
  }
  const settings = loadArkts(
    'settings/SettingsStore.ets',
    ['PAGE_PREFERENCE_KEYS', 'readPagePreferencesSync', 'writePagePreferenceSync'],
    { preferences }
  )
  const { PageStorageStore } = loadArkts('storage/PageStorageStore.ets', ['PageStorageStore'], {
    preferences,
    ...settings
  })
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const client = { onBinaryFrames() {}, cancelById() {} }
  const key = `orca:terminalDrafts:${hostId}:tree:tab`
  const first = new BridgeHost(client, createController(), manifest, meta, `/h/${hostId}`)
  first.setStorage(new PageStorageStore({}, hostId))
  post(first, { type: 'notify', name: 'storage', key, value: 'unsent draft' })
  first.dispose()
  const controller = createController()
  const second = new BridgeHost(client, controller, manifest, meta, `/h/${hostId}`)
  second.setStorage(new PageStorageStore({}, hostId))
  second.onPushChannelReady()
  post(second, { type: 'request', id: 'read', method: 'native.storage.read', params: { key } })
  assert.equal(controller.replies[0].payload.result.value, 'unsent draft')
  second.dispose()
})

test('manifest traversal is rejected before a bundle can be installed', async () => {
  const { WebBundleFetcher } = loadArkts('transport/WebBundleFetcher.ets', ['WebBundleFetcher'])
  const fetcher = new WebBundleFetcher({}, { filesDir: '/unused' })
  await assert.rejects(
    fetcher.ensureBundle({
      buildId: 'safe',
      entrypoint: 'index.html',
      chunkBytes: 49152,
      rangeBytes: 0,
      assets: [{ path: '../../outside', byteLength: 1, sha256: 'a'.repeat(64) }]
    }),
    /Invalid bundle asset/
  )
})

test('stopping dictation sends queued PCM and the partial tail before finish', async () => {
  const peer = createRpcPeer()
  let read
  const capturer = {
    on(_event, callback) {
      read = callback
    },
    off() {},
    start: async () => {},
    stop: async () => {},
    release: async () => {}
  }
  const audio = {
    AudioSamplingRate: {},
    AudioChannel: {},
    AudioSampleFormat: {},
    AudioEncodingType: {},
    SourceType: {},
    createAudioCapturer: async () => capturer
  }
  const { DictationController } = loadArkts(
    'dictation/DictationController.ets',
    ['DictationController'],
    {
      ...peer,
      util,
      audio,
      abilityAccessCtrl: {
        createAtManager: () => ({ requestPermissionsFromUser: async () => ({ authResults: [0] }) })
      }
    }
  )
  const chunks = []
  const order = []
  const rpc = {
    request: async (method, params) => {
      order.push(method)
      if (method === 'speech.dictation.chunk') {
        chunks.push(Buffer.from(JSON.parse(params).audioBase64, 'base64'))
      }
      return new peer.RpcSuccess('response', '{}')
    }
  }
  const controller = new DictationController({}, () => {})
  assert.equal(await controller.start('dictation', rpc), true)
  read(new Uint8Array(5000).buffer)
  await controller.stop()
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(5000))
  assert.equal(order.at(-1), 'speech.dictation.finish')
})

test('the public microphone stop result contains the ring tail and overflow loss', async () => {
  let read
  const capturer = {
    on(event, callback) {
      if (event === 'readData') {
        read = callback
      }
    },
    off() {},
    start: async () => {},
    stop: async () => {},
    release: async () => {}
  }
  const audio = {
    AudioSamplingRate: {},
    AudioChannel: {},
    AudioSampleFormat: {},
    AudioEncodingType: {},
    SourceType: {},
    createAudioCapturer: async () => capturer
  }
  const nativeModules = {
    ...loadArkts('webshell/NativeSpeech.ets', ['NativeSpeech'], { util }),
    ...loadArkts('webshell/NativeImageActions.ets', ['NativeImageActions'], { util }),
    ...loadArkts('webshell/NativePdfViewer.ets', ['NativePdfViewer'], { util })
  }
  const { NativeDevice } = loadArkts('webshell/NativeDevice.ets', ['NativeDevice'], {
    ...bytes,
    ...nativeModules,
    readDictationEngine: async () => 'computer',
    DICTATION_ENGINE_ONDEVICE: 'phone',
    window: {
      getLastWindow: async () => ({
        setWindowKeepScreenOn: async () => {},
        getWindowProperties: () => ({ isKeepScreenOn: false })
      })
    },
    audio,
    abilityAccessCtrl: {
      createAtManager: () => ({ requestPermissionsFromUser: async () => ({ authResults: [0] }) })
    }
  })
  const device = new NativeDevice({})
  await device.serve('native.audio.start', { sampleRate: 16000 })
  read(new Uint8Array(170000).fill(65).buffer)
  const result = await device.serve('native.audio.stop', {})
  assert.equal(result.droppedBytes, 10000)
  assert.deepEqual(Buffer.from(result.base64, 'base64'), Buffer.alloc(160000, 65))
  await device.dispose()
})

test('encoded workspace deep links retain their workspace boundary', () => {
  const { parseLaunchRoute } = loadArkts(
    'navigation/LaunchRoute.ets',
    ['parseLaunchRoute'],
    shellRoutes
  )
  const route = parseLaunchRoute(`orca://session?hostId=${hostId}&worktreeId=tree%2Fone`)
  assert.equal(route.params.route, `/h/${hostId}/session/tree%2Fone`)
  assert.equal(parseLaunchRoute('https://example.com'), null)
})

test('the bridge reports a workspace location without interpreting its encoded ID as a path', () => {
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    createController(),
    {
      ...manifest,
      routes: [
        ...manifest.routes,
        {
          pathname: '/h/[hostId]/session/[worktreeId]',
          canOwnHostArea: true,
          canOwnHostAreaAcrossLayouts: true,
          grants: ['navigate'],
          optionalGrants: []
        }
      ]
    },
    meta,
    `/h/${hostId}`
  )
  const locations = []
  bridge.setLocationSink((pathname, params) =>
    locations.push([pathname, params.executionHost ?? ''])
  )
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  const windowsPathname = `/h/${hostId}/session/repo%3A%3AC%3A%5CMy%20Project`
  const posixPathname = `/h/${hostId}/session/repo%3A%3A%2FUsers%2Fme%2Fproject`
  post(bridge, {
    type: 'notify',
    name: 'location',
    href: `${windowsPathname}?executionHost=runtime%3Awsl`
  })
  post(bridge, { type: 'notify', name: 'location', href: posixPathname })
  post(bridge, { type: 'notify', name: 'location', href: `/h/${hostId}/unserved/repo%2Ffolder` })
  post(bridge, { type: 'notify', name: 'location', href: `/h/${hostId}/session/%2e%2e` })
  post(bridge, {
    type: 'notify',
    name: 'location',
    href: `/h/${'b'.repeat(32)}/session/repo%2Ffolder`
  })
  assert.deepEqual(locations, [
    [windowsPathname, 'runtime:wsl'],
    [posixPathname, '']
  ])
})

test('the workspace drawer opens the created session when an older page posts Back before navigation', async () => {
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const controller = createController()
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    controller,
    {
      ...manifest,
      routes: [
        ...manifest.routes,
        ...['/h/[hostId]/new-workspace', '/h/[hostId]/session/[worktreeId]'].map((pathname) => ({
          pathname,
          grants: ['navigate'],
          optionalGrants: []
        }))
      ]
    },
    meta,
    `/h/${hostId}/new-workspace`
  )
  const exits = []
  bridge.setNavigation(
    () => exits.push('closed'),
    () => {}
  )
  bridge.setOverlayNavigation((pathname, params) =>
    exits.push([pathname, params.name, params.created, params.executionHost])
  )
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  assert.deepEqual(controller.replies.find((frame) => frame.type === 'init').pageRoutes, [
    '/h/[hostId]/new-workspace'
  ])
  const target = `/h/${hostId}/session/folder%3A%2Fremote%2FProject`
  const query = '?name=QA+Session+%2B+Tools&created=1&executionHost=runtime%3Assh'
  const { SHELL_PAGE_CHANNEL_SCRIPT } = loadArkts('webshell/ShellPageChannelScript.ets', [
    'SHELL_PAGE_CHANNEL_SCRIPT'
  ])
  const window = {
    orcaNative: {
      isWorkspaceDrawer: () => true,
      postMessage: (frame) => bridge.onClientMessage(frame)
    }
  }
  runInNewContext(SHELL_PAGE_CHANNEL_SCRIPT, { window, queueMicrotask })
  const notify = (frame) =>
    window.orcaBridge.postMessage(JSON.stringify({ v: 1, type: 'notify', ...frame }))
  post(bridge, { type: 'notify', name: 'location', href: target + query })
  post(bridge, { type: 'notify', name: 'navigate', href: `/h/${'b'.repeat(32)}/session/folder` })
  notify({ name: 'navigate-back' })
  await Promise.resolve()
  assert.deepEqual(exits, ['closed'])
  notify({ name: 'navigate-back' })
  notify({ name: 'navigate', href: target + query, replace: true })
  await Promise.resolve()
  assert.deepEqual(exits, ['closed', [target, 'QA Session + Tools', '1', 'runtime:ssh']])
  bridge.dispose()
})

test('an opened session retains the desktop list across a bridge init and consumes its target once', () => {
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const host = `/h/${hostId}`
  const session = `${host}/session/folder%3Aone`
  const controller = createController()
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    controller,
    {
      ...manifest,
      routes: [
        ...manifest.routes,
        { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'], optionalGrants: [] }
      ]
    },
    meta,
    host
  )
  bridge.setRouteParams({ open: `${session}?paneKey=terminal%3A2` })
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  assert.equal(controller.replies.at(-1).route.params.open, `${session}?paneKey=terminal%3A2`)
  post(bridge, { type: 'notify', name: 'location', href: session })
  post(bridge, {
    type: 'notify',
    name: 'route-param-clear',
    param: 'open',
    value: `${session}?paneKey=terminal%3A2`
  })
  bridge.setUiLocale('zh')
  assert.equal(controller.replies.at(-1).ownsHostArea, true)
  assert.deepEqual(controller.replies.at(-1).route, { pathname: host, params: {} })
  assert.equal(bridge.getRoute(), session)
  bridge.dispose()
})

test('the bridge opens only granted native edit and diagnostics destinations for its paired host', () => {
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    createController(),
    manifest,
    meta,
    `/h/${hostId}`
  )
  const nativePages = []
  bridge.setNativeNavigation((page, replace) => nativePages.push([page, replace]))
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  post(bridge, { type: 'notify', name: 'navigate', href: `/h/${hostId}/edit` })
  post(bridge, {
    type: 'notify',
    name: 'navigate',
    href: `/connection-log?hostId=${hostId}`,
    replace: true
  })
  post(bridge, { type: 'notify', name: 'location', href: `/h/${hostId}/edit` })
  post(bridge, { type: 'notify', name: 'navigate', href: `/h/${'b'.repeat(32)}/edit` })
  post(bridge, {
    type: 'notify',
    name: 'navigate',
    href: `/connection-log?hostId=${'b'.repeat(32)}`
  })
  post(bridge, {
    type: 'notify',
    name: 'navigate',
    href: `/connection-log?hostId=${'b'.repeat(32)}&hostId=${hostId}`
  })
  post(bridge, { type: 'notify', name: 'navigate', href: '/settings' })
  assert.deepEqual(nativePages, [
    ['edit-host', false],
    ['connection-log', true]
  ])
  assert.equal(bridge.getRoute(), `/h/${hostId}`)

  const ungranted = new BridgeHost(
    new peer.SpikeRpcClient(),
    createController(),
    { ...manifest, routes: [] },
    meta,
    `/h/${hostId}`
  )
  ungranted.setNativeNavigation((page, replace) => nativePages.push([page, replace]))
  ungranted.onPushChannelReady()
  post(ungranted, { type: 'ready' })
  post(ungranted, { type: 'notify', name: 'navigate', href: `/h/${hostId}/edit` })
  assert.deepEqual(nativePages, [
    ['edit-host', false],
    ['connection-log', true]
  ])
})

test('the bridge offers preview links only from a granted user navigation', () => {
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], {
    ...peer,
    ...bytes,
    url: { URL: { parseURL: (target) => new URL(target) } }
  })
  const bridge = new BridgeHost(
    new peer.SpikeRpcClient(),
    createController(),
    {
      ...manifest,
      routes: [
        { ...manifest.routes[0], optionalGrants: ['externalNavigation'] },
        { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'], optionalGrants: [] }
      ]
    },
    meta,
    `/h/${hostId}`
  )
  const opened = []
  const open = async (target) => {
    opened.push(target)
  }
  const haptics = async () => {}
  bridge.onPushChannelReady()
  bridge.setDeviceNotifies(open, haptics)
  bridge.offerExternalNavigation('https://unwired.example', true, true, false, 'GET')
  bridge.setDeviceNotifies(open, haptics, true)
  post(bridge, { type: 'ready' })
  bridge.offerExternalNavigation('https://example.com', true, true, false, 'GET')
  bridge.offerExternalNavigation('mailto:review@example.com', true, true, false, 'GET')
  bridge.offerExternalNavigation('https://subframe.example', false, true, false, 'GET')
  bridge.offerExternalNavigation('https://script.example', true, false, false, 'GET')
  bridge.offerExternalNavigation('https://redirect.example', true, true, true, 'GET')
  bridge.offerExternalNavigation('https://form.example', true, true, false, 'POST')
  bridge.offerExternalNavigation('javascript:alert(1)', true, true, false, 'GET')
  post(bridge, { type: 'notify', name: 'location', href: `/h/${hostId}/session/workspace` })
  bridge.offerExternalNavigation('https://ungranted.example', true, true, false, 'GET')
  assert.deepEqual(opened, ['https://example.com/', 'mailto:review@example.com'])
})

test('a socket close reconnects the supervised session and stop cancels further retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer()
  const { HostSession } = loadArkts('transport/HostSession.ets', ['HostSession'], {
    ...peer,
    directPath: () => 'lan',
    LOG_LEVEL_INFO: 'info',
    LOG_LEVEL_SUCCESS: 'success',
    LOG_LEVEL_WARN: 'warn'
  })
  const session = new HostSession(meta, 'synthetic-token')
  const phases = []
  let connected
  session.addListener((phase) => {
    phases.push(phase)
    if (phase === 'connected') {
      connected()
    }
  })
  let connection = new Promise((resolve) => {
    connected = resolve
  })
  session.start()
  await connection
  peer.close()
  connection = new Promise((resolve) => {
    connected = resolve
  })
  t.mock.timers.tick(1000)
  await connection
  session.stop()
  assert.deepEqual(phases, [
    'connecting',
    'handshaking',
    'connected',
    'reconnecting',
    'reconnecting',
    'handshaking',
    'connected',
    'stopped'
  ])
})

test('a network change replaces a stranded handshake and ignores the old socket closing', async (t) => {
  const previousPath = createRpcPeer({ authenticate: false })
  const currentPath = createRpcPeer()
  let availablePath = previousPath
  let now = 10_000
  const { HostSession } = loadArkts('transport/HostSession.ets', ['HostSession'], {
    ...currentPath,
    SpikeRpcClient: function () {
      return new availablePath.SpikeRpcClient()
    },
    Date: { now: () => now },
    directPath: () => 'lan',
    LOG_LEVEL_INFO: 'info',
    LOG_LEVEL_SUCCESS: 'success',
    LOG_LEVEL_WARN: 'warn'
  })
  const session = new HostSession(meta, 'synthetic-token')
  t.after(() => session.stop())
  session.start()
  assert.equal(session.getPhase(), 'handshaking')

  availablePath = currentPath
  now += 3000
  session.revive(true)
  await new Promise(setImmediate)
  assert.equal(session.getPhase(), 'connected')
  previousPath.close()
  assert.equal(session.getPhase(), 'connected')
})
