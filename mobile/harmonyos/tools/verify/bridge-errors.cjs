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
function createBridge(peer, client) {
  const frames = []
  const controller = {
    runJavaScript(script) {
      frames.push(JSON.parse(JSON.parse(script.slice('window.__orcaNativePush('.length, -1))))
      return Promise.resolve()
    }
  }
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], { ...peer, ...bytes })
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
  first.receiveText('{"id":"live","ok":true,"streaming":true,"result":{"title":"before outage"}}')

  bridge.suspendTransport(1)
  post(bridge, { type: 'cancel', id: 'retired', target: 'subscription' })
  post(bridge, { id: 'offline-write', method: 'worktree.create', params: { name: 'draft' } })
  first.receiveText('{"id":"live","ok":true,"streaming":true,"result":{"title":"stale socket"}}')
  bridge.attachTransport(newClient, 'relay')
  post(bridge, { type: 'ready' })
  next.receiveText('{"id":"live","ok":true,"streaming":true,"result":{"title":"after reconnect"}}')
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
