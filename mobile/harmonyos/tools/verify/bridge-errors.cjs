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
    { pathname: '/h/[hostId]', canOwnHostArea: true, grants: ['navigate'], optionalGrants: [] }
  ]
}
function bridgeClass(peer) {
  return loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes }).BridgeHost
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
    { id: hostId, name: 'test', endpoint: 'ws://test' },
    `/h/${hostId}`
  )
  bridge.onPushChannelReady()
  return { bridge, frames }
}
function post(bridge, message) {
  bridge.onClientMessage(JSON.stringify({ v: 1, type: 'request', ...message }))
}

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

test('a cold offline document restores its live stream after authentication and drops its offline write', async () => {
  const peer = createRpcPeer()
  const { bridge, frames } = createBridge(peer, null)
  post(bridge, { type: 'ready' })
  const initial = frames.find((frame) => frame.type === 'init')
  assert.equal(initial.connection.state, 'reconnecting')
  assert.equal(initial.connection.lastConnectedAt, null)
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
