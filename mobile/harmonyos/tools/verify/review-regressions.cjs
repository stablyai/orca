const assert = require('node:assert/strict')
const { test } = require('node:test')
const zlib = require('node:zlib')
const { loadArkts, util } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')

const bytes = loadArkts('transport/crypto/Bytes.ets', ['base64Encode', 'base64Decode'], { util })
const hostId = 'a'.repeat(32)
const meta = { id: hostId, name: 'Test host', endpoint: 'ws://test', publicKeyB64: 'key' }
const manifest = {
  buildId: 'build',
  routes: [
    {
      pathname: '/h/[hostId]',
      canOwnHostArea: true,
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
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], peer)
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
  assert.equal(subscription.id, 'subscription')
  bridge.dispose()
  client.close()
})

test('a draft written through the bridge survives reopening', () => {
  const values = new Map()
  const preferences = {
    getPreferencesSync: () => ({
      getSync: (key, fallback) => values.get(key) ?? fallback,
      putSync: (key, value) => values.set(key, value),
      flushSync() {}
    })
  }
  const { PageStorageStore } = loadArkts('storage/PageStorageStore.ets', ['PageStorageStore'], {
    preferences
  })
  const peer = createRpcPeer()
  const { BridgeHost } = loadArkts('webshell/BridgeHost.ets', ['BridgeHost'], peer)
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
  const { NativeDevice } = loadArkts('webshell/NativeDevice.ets', ['NativeDevice'], {
    ...bytes,
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
  const { parseLaunchRoute } = loadArkts('navigation/LaunchRoute.ets', ['parseLaunchRoute'])
  const route = parseLaunchRoute(`orca://session?hostId=${hostId}&worktreeId=tree%2Fone`)
  assert.equal(route.params.route, `/h/${hostId}/session/tree%2Fone`)
  assert.equal(parseLaunchRoute('https://example.com'), null)
})

test('a socket close reconnects the supervised session and stop cancels further retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = createRpcPeer()
  const { HostSession } = loadArkts('transport/HostSession.ets', ['HostSession'], peer)
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
    'connected',
    'reconnecting',
    'reconnecting',
    'connected',
    'stopped'
  ])
})
