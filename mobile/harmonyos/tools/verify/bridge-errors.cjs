const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts, util } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')
const bytes = loadArkts(
  'transport/crypto/Bytes.ets',
  ['utf8Encode', 'utf8Decode', 'base64Encode'],
  { util }
)
const hostId = 'a'.repeat(32)
const manifest = {
  buildId: 'test',
  routes: [
    {
      pathname: '/h/[hostId]',
      canOwnHostArea: true,
      canOwnHostAreaAcrossLayouts: true,
      grants: ['navigate'],
      optionalGrants: ['native.media.pick']
    }
  ]
}
function bridgeClass(peer, bindings = {}) {
  return loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes, ...bindings })
    .BridgeHost
}
function createBridge(peer, client, BridgeHost = bridgeClass(peer)) {
  const frames = []
  const controller = {
    runJavaScript(script) {
      frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
  const bridge = new BridgeHost(
    client,
    controller,
    manifest,
    { id: hostId, name: 'test', endpoint: 'ws://test', hostPlatform: 'darwin' },
    `/h/${hostId}`
  )
  bridge.onPushChannelReady()
  return { bridge, frames }
}
function post(bridge, message) {
  bridge.onClientMessage(JSON.stringify({ v: 1, type: 'request', ...message }))
}

test('the offline Automations page reads a catalog larger than one frame without granting it to the host page', () => {
  const BridgeHost = bridgeClass(createRpcPeer())
  const verb = 'native.automation.catalog.read'
  const root = `/h/${hostId}`
  const catalog = {
    automations: [{ id: 'scheduled', prompt: '测试🙂'.repeat(75_000) }],
    items: [{ automationId: 'scheduled', selector: { kind: 'self' } }]
  }
  const build = {
    ...manifest,
    routes: [
      ...manifest.routes,
      { pathname: '/h/[hostId]/automations', grants: [], optionalGrants: [verb] }
    ]
  }
  const run = (pathname) => {
    const frames = []
    const view = {
      runJavaScript(script) {
        frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
        return Promise.resolve()
      }
    }
    const bridge = new BridgeHost(null, view, build, { id: hostId }, pathname)
    bridge.setAutomationCatalog(() => ({ result: JSON.stringify(catalog), readAt: 1_000 }))
    bridge.onPushChannelReady()
    post(bridge, { type: 'ready' })
    post(bridge, { id: 'read-automation', method: verb, params: {} })
    bridge.dispose()
    return frames.filter((frame) => frame.id === 'read-automation')
  }
  const parts = run(`${root}/automations`)
  assert.ok(parts.every((frame) => frame.part && frame.type === 'reply'))
  assert.deepEqual(JSON.parse(parts.map((frame) => frame.chunk).join('')).result, {
    readAt: 1_000,
    result: catalog
  })
  assert.equal(run(root)[0].error.code, 'native_verb_ungranted')
})

test('only a live page that negotiated app inactivity receives the save signal', () => {
  const peer = createRpcPeer()
  const { bridge, frames } = createBridge(peer, null)
  post(bridge, { type: 'ready' })
  bridge.sendAppInactive()
  assert.equal(frames.at(-1).type, 'init')

  post(bridge, { type: 'ready', appInactiveFrames: true })
  bridge.sendAppInactive()
  assert.deepEqual(frames.at(-1), { v: 1, type: 'appInactive' })

  post(bridge, { type: 'close' })
  post(bridge, { type: 'ready' })
  bridge.sendAppInactive()
  assert.equal(frames.at(-1).type, 'init')
})

test('a ready document can report one fault without a desktop manifest grant', () => {
  const { bridge, frames } = createBridge(createRpcPeer(), null)
  const faults = []
  bridge.setFaultSink((message) => faults.push(message))
  const fault = {
    type: 'notify',
    name: 'fault',
    error: { category: 'page', message: 'fixture failure', isRpcDeliveryUnknown: false }
  }
  post(bridge, fault)
  assert.deepEqual(faults, [])
  post(bridge, { type: 'ready' })
  assert.ok(frames.find((frame) => frame.type === 'init').grants.native.includes('fault'))
  post(bridge, fault)
  post(bridge, fault)
  assert.equal(faults.length, 1)
  bridge.dispose()
})

test('an oversized document is refused with the native media size reason and a smaller retry works', async () => {
  let size = 18 * 1024 * 1024 + 1
  const { NativeDevice, NativeMediaTooLargeError } = loadArkts(
    'webshell/NativeDevice.ets',
    ['NativeDevice', 'NativeMediaTooLargeError'],
    {
      NativeSpeech: class {},
      NativeImageActions: class {},
      NativePdfViewer: class {},
      picker: {
        DocumentSelectOptions: class {},
        DocumentViewPicker: class {
          async select() {
            return ['file://docs/fixture.txt']
          }
        }
      },
      fs: {
        OpenMode: { READ_ONLY: 1 },
        open: async () => ({ fd: 1 }),
        stat: async () => ({ size }),
        read: async (_fd, buffer) => {
          new Uint8Array(buffer).set([111, 114, 99])
          return 3
        },
        close: async () => {}
      }
    }
  )
  const device = new NativeDevice({})
  const peer = createRpcPeer()
  const { bridge, frames } = createBridge(
    peer,
    null,
    bridgeClass(peer, { NativeMediaTooLargeError })
  )
  bridge.setNativeHandler(device.methods, (method, params) => device.serve(method, params))
  const request = (id) =>
    post(bridge, { id, method: 'native.media.pick', params: { source: 'files', multiple: true } })
  request('oversized')
  await new Promise(setImmediate)
  assert.equal(
    frames.find((frame) => frame.id === 'oversized' && frame.type === 'error').error.code,
    'native_media_too_large'
  )
  size = 3
  request('retry')
  await new Promise(setImmediate)
  assert.equal(frames.find((frame) => frame.id === 'retry').payload.result.items[0].byteLength, 3)
  bridge.dispose()
})

test('two documents on one connection receive and cancel only their own calls', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  const BridgeHost = bridgeClass(peer)
  const first = createBridge(peer, client, BridgeHost)
  const second = createBridge(peer, client, BridgeHost)
  for (const { bridge } of [first, second]) {
    post(bridge, { id: 'page-request', method: 'status.get' })
    post(bridge, { type: 'subscribe', id: 'page-stream', method: 'session.tabs.subscribeAll' })
  }
  const [firstCall, firstStream, secondCall, secondStream] = peer.sent.map(JSON.parse)
  first.bridge.dispose()
  const release = peer.sent
    .map(JSON.parse)
    .find((wire) => wire.method === 'session.tabs.unsubscribeAll')
  assert.equal(release.params.subscriptionId, firstStream.id)
  peer.receiveText(JSON.stringify({ id: firstCall.id, ok: true, result: { title: 'first' } }))
  peer.receiveText(JSON.stringify({ id: secondCall.id, ok: true, result: { title: 'second' } }))
  peer.receiveText(
    JSON.stringify({ id: secondStream.id, ok: true, streaming: true, result: { title: 'live' } })
  )
  await new Promise(setImmediate)
  assert.deepEqual(second.frames.find((frame) => frame.type === 'reply').payload, {
    id: 'page-request',
    ok: true,
    result: { title: 'second' }
  })
  assert.equal(second.frames.find((frame) => frame.id === 'page-stream').payload.title, 'live')
  second.bridge.dispose()
  client.close()
})

test('an unconfirmed mutation timeout reaches the page with delivery ambiguity intact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  const { bridge, frames } = createBridge(peer, client)
  post(bridge, { id: 'mutation', method: 'worktree.create', options: { timeoutMs: 1000 } })
  t.mock.timers.tick(1000)
  await new Promise(setImmediate)
  assert.equal(frames[0].type, 'error')
  assert.equal(frames[0].error.category, 'Error')
  assert.equal(frames[0].error.isRpcDeliveryUnknown, true)
  bridge.dispose()
  client.close()
})

test('a refused duplicate request sends the page a readable definite failure', async () => {
  const peer = createRpcPeer()
  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  const { bridge, frames } = createBridge(peer, client)
  post(bridge, { id: 'same', method: 'status.get' })
  post(bridge, { id: 'same', method: 'status.get' })
  assert.equal(frames[0].type, 'error')
  assert.equal(frames[0].error.category, 'Error')
  assert.equal(frames[0].error.isRpcDeliveryUnknown, false)
  bridge.dispose()
  client.close()
})

test('a cached workspace sees the relay outage and clears it on authenticated reconnect', async (t) => {
  const peer = createRpcPeer()
  const { bridge, frames } = createBridge(peer, null)
  const client = new peer.SpikeRpcClient()
  t.after(() => {
    bridge.dispose()
    client.close()
  })
  bridge.suspendTransport(3, 'relay', 'host-offline')
  post(bridge, { type: 'ready' })
  const init = frames.find((frame) => frame.type === 'init')
  assert.equal(init.connection.pendingPath, 'relay')
  assert.equal(init.connection.relayHostReachability, 'host-offline')

  await client.connect('ws://test', 'test-token', 'key', 'v2')
  bridge.attachTransport(client, 'relay')
  const restored = frames.findLast((frame) => frame.type === 'state').connection
  assert.equal(restored.state, 'connected')
  assert.equal(restored.activePath, 'relay')
  assert.equal(restored.pendingPath, undefined)
  assert.equal(restored.relayHostReachability, undefined)
})

test('a cold offline document restores its live stream after authentication and drops its offline write', async () => {
  const peer = createRpcPeer()
  const { bridge, frames } = createBridge(peer, null)
  post(bridge, { type: 'ready' })
  const initial = frames.find((frame) => frame.type === 'init')
  assert.equal(initial.connection.state, 'reconnecting')
  assert.equal(initial.connection.lastConnectedAt, null)
  assert.equal(initial.host.lastKnownHostPlatform, 'darwin')
  post(bridge, { type: 'subscribe', id: 'catalog', method: 'session.tabs.subscribeAll' })
  post(bridge, { id: 'write', method: 'worktree.create', params: { name: 'offline draft' } })
  assert.equal(frames.find((frame) => frame.id === 'write').error.isRpcDeliveryUnknown, false)

  const client = new peer.SpikeRpcClient()
  await client.connect('ws://test', 'test-token', 'key', 'v2')
  bridge.attachTransport(client, 'lan')
  const [wire] = peer.sent.map(JSON.parse)
  assert.deepEqual(
    peer.sent.map((entry) => JSON.parse(entry).method),
    ['session.tabs.subscribeAll']
  )
  peer.receiveText(
    JSON.stringify({ id: wire.id, ok: true, streaming: true, result: { title: 'recovered' } })
  )
  await new Promise(setImmediate)
  assert.equal(frames.find((frame) => frame.id === 'catalog').payload.title, 'recovered')
  post(bridge, { type: 'ready' })
  assert.equal(frames.findLast((frame) => frame.type === 'init').sessionId, initial.sessionId)
  bridge.dispose()
  client.close()
})

test('Back ignores unopened or closed bridges and falls through when a claimed press cannot reach the page', async () => {
  const BridgeHost = bridgeClass(createRpcPeer())
  const root = `/h/${hostId}`
  const routed = []
  const backFrames = []
  const controller = {
    runJavaScript(script) {
      if (script.endsWith(', false)')) {
        backFrames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -8))))
        return Promise.resolve('"unavailable"')
      }
      return Promise.resolve('')
    }
  }
  const bridge = new BridgeHost(null, controller, manifest, { id: hostId }, root)
  bridge.setNavigation(
    () => routed.push('page'),
    () => {}
  )
  const back = () => post(bridge, { type: 'notify', name: 'navigate-back' })
  const claim = () => post(bridge, { type: 'notify', name: 'back-claim', claimed: true })
  claim()
  back()
  assert.equal(bridge.handleBack(), false)
  assert.deepEqual(routed, [])
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  claim()
  assert.equal(
    bridge.handleBack(() => routed.push('native')),
    true
  )
  assert.equal(
    bridge.handleBack(() => routed.push('duplicate')),
    true
  )
  await new Promise(setImmediate)
  assert.deepEqual(backFrames, [{ v: 1, type: 'back' }])
  assert.deepEqual(routed, ['native'])
  back()
  claim()
  post(bridge, { type: 'close' })
  back()
  assert.equal(bridge.handleBack(), false)
  assert.deepEqual(routed, ['native', 'page'])
  bridge.dispose()

  const ungranted = new BridgeHost(
    null,
    controller,
    { ...manifest, routes: [] },
    { id: hostId },
    root
  )
  ungranted.onPushChannelReady()
  post(ungranted, { type: 'ready' })
  ungranted.setNavigation(
    () => routed.push('ungranted'),
    () => {}
  )
  post(ungranted, { type: 'notify', name: 'navigate-back' })
  assert.deepEqual(routed, ['native', 'page'])
  ungranted.dispose()
})

test('a pending stack transition suppresses a second Back and an old rejection cannot release the next visit', () => {
  const { ShellNavigationFence } = loadArkts('navigation/ShellNavigationFence.ets', [
    'ShellNavigationFence'
  ])
  const fence = new ShellNavigationFence()
  const previous = fence.begin()
  assert.notEqual(previous, 0)
  assert.equal(fence.begin(), 0)
  fence.visit()
  const current = fence.begin()
  fence.reject(previous)
  assert.equal(fence.begin(), 0)
  fence.reject(current)
  assert.notEqual(fence.begin(), 0)
})

test('a narrow legacy host list hands sessions to the native stack and refuses unavailable required grants', () => {
  const BridgeHost = bridgeClass(createRpcPeer())
  const frames = []
  const root = `/h/${hostId}`
  const build = {
    buildId: 'legacy',
    routes: [
      { pathname: '/h/[hostId]', canOwnHostArea: true, grants: ['navigate'], optionalGrants: [] },
      {
        pathname: '/h/[hostId]/session/[worktreeId]',
        grants: ['navigate'],
        optionalGrants: ['native.future.optional']
      },
      {
        pathname: '/h/[hostId]/files/[worktreeId]',
        grants: ['native.future.required'],
        optionalGrants: []
      }
    ]
  }
  const controller = {
    runJavaScript(script) {
      frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
  const bridge = new BridgeHost(null, controller, build, { id: hostId }, root)
  const opened = []
  bridge.setShellNavigation((pathname, params) => opened.push([pathname, params.paneKey]))
  bridge.onPushChannelReady()
  post(bridge, { type: 'ready' })
  assert.equal(frames[0].ownsHostArea, false)
  assert.deepEqual(frames[0].pageRoutes, ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]'])
  assert.deepEqual(frames[0].pageRouteGrants[1].grants, ['navigate'])
  assert.equal(bridge.routeBlock(`${root}/files/tree`), 'mobile')
  assert.equal(bridge.routeBlock(`${root}/missing`), 'desktop')
  post(bridge, { type: 'notify', name: 'navigate', href: `${root}/session/tree?paneKey=target` })
  assert.deepEqual(opened, [[`${root}/session/tree`, 'target']])
  assert.equal(bridge.getRoute(), root)
  bridge.dispose()
})

test('reconnect preserves the page and restores live streams without repeating writes', async () => {
  const first = createRpcPeer()
  const next = createRpcPeer()
  const oldClient = new first.SpikeRpcClient()
  const newClient = new next.SpikeRpcClient()
  await oldClient.connect('ws://test', 'first-token', 'key', 'v2')
  await newClient.connect('ws://test', 'second-token', 'key', 'v2')
  const { bridge, frames } = createBridge(first, oldClient)
  post(bridge, { type: 'ready' })
  const document = frames.find((frame) => frame.type === 'init').sessionId
  post(bridge, { type: 'subscribe', id: 'live', method: 'session.tabs.subscribeAll' })
  post(bridge, { type: 'subscribe', id: 'retired', method: 'notifications.subscribe' })
  post(bridge, { id: 'write', method: 'worktree.create', params: { name: 'draft' } })
  post(bridge, {
    type: 'subscribe',
    id: 'unsafe',
    method: 'worktree.create',
    params: { name: 'draft' }
  })
  function streamEvent(peer, title) {
    const { id } = peer.sent
      .map(JSON.parse)
      .find((wire) => wire.method === 'session.tabs.subscribeAll')
    peer.receiveText(JSON.stringify({ id, ok: true, streaming: true, result: { title } }))
  }
  streamEvent(first, 'before outage')

  bridge.suspendTransport(1)
  post(bridge, { type: 'cancel', id: 'retired', target: 'subscription' })
  post(bridge, { id: 'offline-write', method: 'worktree.create', params: { name: 'draft' } })
  streamEvent(first, 'stale socket')
  bridge.attachTransport(newClient, 'relay')
  post(bridge, { type: 'ready' })
  streamEvent(next, 'after reconnect')
  await new Promise(setImmediate)

  assert.equal(frames.findLast((frame) => frame.type === 'init').sessionId, document)
  assert.deepEqual(
    frames.filter((frame) => frame.id === 'live').map((frame) => frame.payload?.title),
    ['before outage', 'after reconnect']
  )
  assert.equal(frames.find((frame) => frame.id === 'write').error.isRpcDeliveryUnknown, true)
  assert.equal(
    frames.find((frame) => frame.id === 'offline-write').error.isRpcDeliveryUnknown,
    false
  )
  assert.deepEqual(
    next.sent.map((wire) => JSON.parse(wire).method),
    ['session.tabs.subscribeAll']
  )
  bridge.dispose()
  oldClient.close()
  newClient.close()
})
