import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  RelayLoadControlPeer,
  relayLoadWedgedCloseAccepted
} from './relay-load-control-peer.mjs'

const requireFromRelay = createRequire(new URL('../../apps/relay/package.json', import.meta.url))
const nacl = requireFromRelay('tweetnacl')
const { buildHostChallengePlaintext } = await import(
  requireFromRelay.resolve('@orca-cloud/relay-contract')
)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function peerOptions(overrides = {}) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    authOrigin: 'https://auth.test',
    directorOrigin: 'https://director.test',
    reconnectMaxMs: 0,
    seed: 1,
    signingKey: privateKey,
    signingKeyId: 'test-key',
    ...overrides
  }
}

function response(body) {
  return { ok: true, status: 200, json: async () => body }
}

function fakeOpenSocket() {
  const socket = new EventEmitter()
  socket.OPEN = 1
  socket.CLOSING = 2
  socket.CLOSED = 3
  socket.readyState = socket.OPEN
  socket.sent = []
  socket.send = (message) => socket.sent.push(message)
  socket.close = (code = 1000, reason = '') => {
    socket.readyState = socket.CLOSING
    queueMicrotask(() => {
      socket.readyState = socket.CLOSED
      socket.emit('close', code, Buffer.from(reason))
    })
  }
  socket.terminate = socket.close
  return socket
}

function fakeHandshakeSocket() {
  const socket = fakeOpenSocket()
  socket.CONNECTING = 0
  socket.readyState = socket.CONNECTING
  socket.open = () => {
    socket.readyState = socket.OPEN
    socket.emit('open')
  }
  socket.message = (message) => socket.emit('message', Buffer.from(JSON.stringify(message)))
  return socket
}

function openOnNextTurn(socket) {
  queueMicrotask(() => socket.open())
  return socket
}

function validChallenge(peer) {
  const relayKeys = nacl.box.keyPair()
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plaintext = buildHostChallengePlaintext(
    new Uint8Array([1, 2, 3]),
    nacl.randomBytes(32)
  )
  const ciphertext = nacl.box(plaintext, nonce, peer.keys.publicKey, relayKeys.secretKey)
  return {
    type: 'host-challenge',
    challengeId: 'test-challenge',
    ciphertextB64: Buffer.from(ciphertext).toString('base64'),
    nonceB64: Buffer.from(nonce).toString('base64'),
    relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64')
  }
}

test('shutdown waits for pending assignment and prevents a late connection', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  const assignment = deferred()
  const assignmentStarted = deferred()
  global.fetch = () => {
    assignmentStarted.resolve()
    return assignment.promise
  }
  const observations = []
  const peer = new RelayLoadControlPeer(0, peerOptions(), (type) => observations.push(type))

  const connecting = peer.connect()
  await assignmentStarted.promise
  let shutdownFinished = false
  const shutdown = peer.shutdown().then(() => {
    shutdownFinished = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(shutdownFinished, false)

  assignment.resolve(response({ cellUrl: 'https://cell.test', assignmentEpoch: 1 }))
  await Promise.all([connecting, shutdown])
  assert.equal(peer.socket, null)
  assert.equal(observations.includes('connected'), false)
})

test('shutdown after socket open prevents a late handshake', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ directorOrigin: undefined, targetOrigin: 'https://cell.test' }),
    (type) => observations.push(type)
  )
  const socket = fakeHandshakeSocket()
  const socketCreated = deferred()
  peer.createSocket = () => {
    socketCreated.resolve()
    return socket
  }

  const connecting = peer.connect()
  await socketCreated.promise
  socket.open()
  await Promise.all([connecting, peer.shutdown()])

  assert.deepEqual(socket.sent, [])
  assert.equal(observations.includes('connected'), false)
})

test('shutdown after challenge prevents a late acknowledgement', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ directorOrigin: undefined, targetOrigin: 'https://cell.test' }),
    (type) => observations.push(type)
  )
  const socket = fakeHandshakeSocket()
  const socketCreated = deferred()
  const helloSent = deferred()
  socket.send = (message) => {
    socket.sent.push(message)
    helloSent.resolve()
  }
  peer.createSocket = () => {
    socketCreated.resolve()
    return socket
  }

  const connecting = peer.connect()
  await socketCreated.promise
  socket.open()
  await helloSent.promise
  socket.message({ type: 'host-challenge' })
  await Promise.all([connecting, peer.shutdown()])

  assert.equal(socket.sent.length, 1)
  assert.equal(observations.includes('connected'), false)
})

test('shutdown after host acknowledgement prevents a late connected observation', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ directorOrigin: undefined, targetOrigin: 'https://cell.test' }),
    (type) => observations.push(type)
  )
  const socket = fakeHandshakeSocket()
  const socketCreated = deferred()
  const helloSent = deferred()
  const proofSent = deferred()
  socket.send = (message) => {
    socket.sent.push(message)
    if (socket.sent.length === 1) helloSent.resolve()
    else proofSent.resolve()
  }
  peer.createSocket = () => {
    socketCreated.resolve()
    return socket
  }

  const connecting = peer.connect()
  await socketCreated.promise
  socket.open()
  await helloSent.promise
  socket.message(validChallenge(peer))
  await proofSent.promise
  socket.message({ type: 'host-hello-ack', generation: 1, controlResumeSecret: 'test-secret' })
  await Promise.all([connecting, peer.shutdown()])

  assert.equal(socket.sent.length, 2)
  assert.equal(observations.includes('connected'), false)
})

test('shutdown prevents a pending refresh from sending or reporting success', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  const token = deferred()
  const tokenStarted = deferred()
  global.fetch = () => {
    tokenStarted.resolve()
    return token.promise
  }
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ accessToken: 'test-access-token', directorOrigin: undefined }),
    (type) => observations.push(type)
  )
  const socket = fakeOpenSocket()
  peer.socket = socket

  const refreshing = peer.refresh()
  await tokenStarted.promise
  const shutdown = peer.shutdown()
  token.resolve(response({ relayToken: 'test-relay-token' }))
  await Promise.all([refreshing, shutdown])

  assert.deepEqual(socket.sent, [])
  assert.equal(observations.includes('refresh'), false)
  assert.equal(observations.includes('refreshError'), false)
})

test('shutdown suppresses a late refresh error', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  const token = deferred()
  const tokenStarted = deferred()
  global.fetch = () => {
    tokenStarted.resolve()
    return token.promise
  }
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ accessToken: 'test-access-token', directorOrigin: undefined }),
    (type) => observations.push(type)
  )
  peer.socket = fakeOpenSocket()

  const refreshing = peer.refresh()
  await tokenStarted.promise
  const shutdown = peer.shutdown()
  token.reject(new Error('late token failure'))
  await Promise.all([refreshing, shutdown])

  assert.equal(observations.includes('refreshError'), false)
})

test('shutdown aborts an HTTP request that would otherwise remain pending', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  const requestStarted = deferred()
  let aborted = false
  global.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      requestStarted.resolve()
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('request aborted'))
        },
        { once: true }
      )
    })
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ accessToken: 'test-access-token', directorOrigin: undefined }),
    (type) => observations.push(type)
  )

  const connecting = peer.connect()
  await requestStarted.promise
  await Promise.all([connecting, peer.shutdown()])

  assert.equal(aborted, true)
  assert.equal(observations.includes('connected'), false)
})

test('bounds a pending HTTP request with a classified timeout', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  global.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
    })
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({
      accessToken: 'test-access-token',
      directorOrigin: undefined,
      requestTimeoutMs: 1
    }),
    () => undefined
  )

  await assert.rejects(peer.connect(), /relay token exchange timeout/)
  await peer.shutdown()
})

test('bounds a stalled token response body', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })
      })
  })
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({
      accessToken: 'test-access-token',
      directorOrigin: undefined,
      requestTimeoutMs: 1
    }),
    () => undefined
  )

  await assert.rejects(peer.connect(), /relay token exchange timeout/)
  await peer.shutdown()
})

test('bounds a stalled assignment response body', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })
      })
  })
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ requestTimeoutMs: 1 }),
    () => undefined
  )

  await assert.rejects(peer.connect(), /relay assignment timeout/)
  await peer.shutdown()
})

test('shutdown aborts a stalled successful response body', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  const bodyStarted = deferred()
  let bodyAborted = false
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        bodyStarted.resolve()
        signal.addEventListener(
          'abort',
          () => {
            bodyAborted = true
            reject(new Error('body aborted'))
          },
          { once: true }
        )
      })
  })
  const observations = []
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ accessToken: 'test-access-token', directorOrigin: undefined }),
    (type) => observations.push(type)
  )

  const connecting = peer.connect()
  await bodyStarted.promise
  await Promise.all([connecting, peer.shutdown()])

  assert.equal(bodyAborted, true)
  assert.equal(observations.includes('connected'), false)
})

test('cancels a rejected HTTP response body', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  let canceled = false
  global.fetch = async () => ({
    ok: false,
    status: 503,
    body: {
      cancel: async () => {
        canceled = true
      }
    }
  })
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ accessToken: 'test-access-token', directorOrigin: undefined }),
    () => undefined
  )

  await assert.rejects(peer.connect(), /relay token exchange failed: 503/)
  await peer.shutdown()
  assert.equal(canceled, true)
})

test('preserves only an exact capacity assignment rejection reason', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'relay_connection_headroom_exhausted' })
  })
  const peer = new RelayLoadControlPeer(0, peerOptions(), () => undefined)

  await assert.rejects(
    peer.connect(),
    /relay assignment failed: 503 relay_connection_headroom_exhausted/
  )
  await peer.shutdown()
})

test('sends preferred region and preserves the genuine director epoch', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  let assignmentRequest
  global.fetch = async (_url, init) => {
    assignmentRequest = JSON.parse(init.body)
    return response({ cellUrl: 'https://asia-cell.test', assignmentEpoch: 47 })
  }
  const peer = new RelayLoadControlPeer(
    0,
    peerOptions({ preferredRegion: 'asia-east2' }),
    () => undefined
  )

  const assignment = await peer.assignment('relay-token')

  assert.deepEqual(assignmentRequest, {
    v: 1,
    relayHostId: peer.relayHostId,
    preferredRegion: 'asia-east2'
  })
  assert.equal(assignment.assignmentEpoch, 47)
  await peer.shutdown()
})

test('omits preferred region and rejects a fabricated director epoch', async (context) => {
  const originalFetch = global.fetch
  context.after(() => {
    global.fetch = originalFetch
  })
  let assignmentRequest
  global.fetch = async (_url, init) => {
    assignmentRequest = JSON.parse(init.body)
    return response({ cellUrl: 'https://cell.test', assignmentEpoch: 0 })
  }
  const peer = new RelayLoadControlPeer(0, peerOptions(), () => undefined)

  await assert.rejects(peer.assignment('relay-token'), /assignment response invalid/)
  assert.equal('preferredRegion' in assignmentRequest, false)
  await peer.shutdown()
})

test('rejects ambiguous direct and director assignment modes', () => {
  assert.throws(
    () =>
      new RelayLoadControlPeer(
        0,
        peerOptions({ targetOrigin: 'https://cell.test' }),
        () => undefined
      ),
    /either directorOrigin or targetOrigin/
  )
})

test('opens a genuine splice and verifies payloads in both directions', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(3, peerOptions(), (type, detail) => {
    observations.push({ type, detail })
  })
  const control = fakeOpenSocket()
  const phone = fakeHandshakeSocket()
  const data = fakeHandshakeSocket()
  let dataPayloadBytes = 0
  let observationStarted = false
  let sentBeforeObservation = false
  let paused = 0
  let resumed = 0
  phone._socket = {
    pause: () => paused++,
    resume: () => resumed++
  }
  control.send = (raw) => {
    const message = JSON.parse(raw)
    if (message.type === 'invite-create') {
      queueMicrotask(() =>
        control.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'invite-created',
              reqId: message.reqId,
              inviteToken: 'invite-token'
            })
          )
        )
      )
    }
  }
  phone.send = (raw) => {
    if (typeof raw === 'string' && raw.startsWith('{') && JSON.parse(raw).type === 'relay-auth') {
      queueMicrotask(() =>
        control.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'conn-open',
              relayDeviceId: 'load-device-3-0',
              connId: 'connection-1',
              connTicket: 'connection-ticket'
            })
          )
        )
      )
      return
    }
    queueMicrotask(() => data.emit('message', Buffer.from(raw), false))
  }
  data.send = (raw) => {
    if (typeof raw === 'string') {
      queueMicrotask(() => phone.emit('message', Buffer.from(JSON.stringify({ ok: true })), false))
      return
    }
    const dataPayload = Buffer.from(raw)
    if (!observationStarted) sentBeforeObservation = true
    dataPayloadBytes += dataPayload.byteLength
    queueMicrotask(() => phone.emit('message', dataPayload, true))
  }
  peer.socket = control
  peer.generation = 9
  peer.lastAssignment = { cellUrl: 'https://cell.test', assignmentEpoch: 47 }
  control.on('message', (raw) => peer.onMessage(control, raw))
  peer.createClientSocket = () => openOnNextTurn(phone)
  peer.createHostDataSocket = () => openOnNextTurn(data)

  await peer.openSplice({
    readerMode: 'slow',
    readerHoldMs: 1,
    streamBytes: 300 * 1024,
    frameBytes: 64 * 1024,
    observeReaderPressure: async () => { observationStarted = true }
  })

  assert.equal(dataPayloadBytes, 300 * 1024)
  assert.equal(sentBeforeObservation, false)
  assert.equal(paused, 1)
  assert.equal(resumed, 1)
  assert.equal(observations.filter(({ type }) => type === 'spliceCompleted').length, 1)
  assert.equal(observations.some(({ type }) => type === 'spliceFailed'), false)
  await peer.shutdown()
  assert.deepEqual(observations.at(-1), {
    type: 'shutdown',
    detail: {
      index: 3,
      activeControls: 0,
      activeSpliceSockets: 0,
      inFlightOperations: 0,
      refreshTimerActive: false
    }
  })
})

test('opens invitation leases and preserves exact capacity errors', async () => {
  const peer = new RelayLoadControlPeer(4, peerOptions(), () => undefined)
  const control = fakeOpenSocket()
  peer.socket = control
  control.on('message', (raw) => peer.onMessage(control, raw))
  let calls = 0
  control.send = (raw) => {
    const request = JSON.parse(raw)
    calls++
    queueMicrotask(() => control.emit('message', Buffer.from(JSON.stringify(
      calls === 1
        ? {
            type: 'invite-created', reqId: request.reqId,
            inviteToken: 'invite-token', expiresAt: Date.now() + 60_000
          }
        : { type: 'control-error', reqId: request.reqId, code: 'relay_capacity_exhausted' }
    ))))
  }

  await peer.openInviteOffer()
  await assert.rejects(peer.openInviteOffer(), /invite offer failed: relay_capacity_exhausted/)
  await peer.shutdown()
})

test('can request the same assignment with an explicit replacement preference', async (context) => {
  const originalFetch = global.fetch
  context.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/assign')) {
      requests.push(JSON.parse(init.body))
      return response({ cellUrl: 'https://asia-cell.test', assignmentEpoch: 3 })
    }
    return response({ relayToken: 'relay-token' })
  }
  const peer = new RelayLoadControlPeer(
    5,
    peerOptions({ accessToken: 'access-token', preferredRegion: 'asia-east2' }),
    () => undefined
  )

  assert.equal((await peer.requestAssignment('us-central1')).cellUrl, 'https://asia-cell.test')
  assert.equal(requests[0].preferredRegion, 'us-central1')
  await peer.shutdown()
})

test('uses a refreshable workflow access-token provider', async (context) => {
  const originalFetch = global.fetch
  context.after(() => { global.fetch = originalFetch })
  let providerCalls = 0
  let authorization
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/desktop/auth/relay-token')) {
      authorization = init.headers.authorization
      return response({ relayToken: 'relay-token' })
    }
    return response({ cellUrl: 'https://cell.test', assignmentEpoch: 1 })
  }
  const peer = new RelayLoadControlPeer(6, peerOptions({
    accessTokenProvider: async () => {
      providerCalls++
      return 'refreshed-access-token'
    }
  }), () => undefined)

  await peer.requestAssignment('asia-east2')
  assert.equal(providerCalls, 1)
  assert.equal(authorization, 'Bearer refreshed-access-token')
  await peer.shutdown()
})

test('accepts a forced close only when the responsive splice leg receives 4429', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(7, peerOptions(), (type, detail) => {
    observations.push({ type, detail })
  })
  const control = fakeOpenSocket()
  const phone = fakeHandshakeSocket()
  const data = fakeHandshakeSocket()
  let streamStarted
  const streamStartedPromise = new Promise((resolve) => { streamStarted = resolve })
  phone._socket = { pause: () => undefined, resume: () => undefined }
  control.send = (raw) => {
    const message = JSON.parse(raw)
    queueMicrotask(() => control.emit('message', Buffer.from(JSON.stringify({
      type: 'invite-created', reqId: message.reqId, inviteToken: 'invite-token'
    }))))
  }
  phone.send = (raw) => {
    if (typeof raw === 'string' && raw.startsWith('{')) {
      queueMicrotask(() => control.emit('message', Buffer.from(JSON.stringify({
        type: 'conn-open', relayDeviceId: 'load-device-7-0',
        connId: 'connection-7', connTicket: 'connection-ticket'
      }))))
    }
  }
  data.send = (raw) => {
    if (typeof raw === 'string') {
      queueMicrotask(() => phone.emit('message', Buffer.from(JSON.stringify({ ok: true })), false))
    } else {
      streamStarted()
    }
  }
  peer.socket = control
  peer.generation = 11
  peer.lastAssignment = { cellUrl: 'https://cell.test', assignmentEpoch: 9 }
  control.on('message', (raw) => peer.onMessage(control, raw))
  peer.createClientSocket = () => openOnNextTurn(phone)
  peer.createHostDataSocket = () => openOnNextTurn(data)

  await peer.openSplice({
    readerMode: 'wedged',
    readerHoldMs: 10_001,
    streamBytes: 300 * 1024,
    frameBytes: 64 * 1024,
    observeReaderPressure: async () => {
      await streamStartedPromise
      phone.close(1006)
      data.close(4429, 'wedged relay link')
    },
    readerDelay: async () => undefined
  })

  assert.equal(observations.filter(({ type }) => type === 'spliceWedged').length, 1)
  assert.equal(observations.find(({ type }) => type === 'spliceWedged').detail.code, 4429)
  await peer.shutdown()
})

test('requires one 4429 and rejects unrelated wedged close codes', () => {
  assert.equal(relayLoadWedgedCloseAccepted([4429, 4429]), true)
  assert.equal(relayLoadWedgedCloseAccepted([1006, 4429]), true)
  assert.equal(relayLoadWedgedCloseAccepted([4429, 1006]), false)
  assert.equal(relayLoadWedgedCloseAccepted([1006, 1006]), false)
  assert.equal(relayLoadWedgedCloseAccepted([1000, 4429]), false)
  assert.equal(relayLoadWedgedCloseAccepted([4429]), false)
  assert.equal(relayLoadWedgedCloseAccepted([1006, 4429, 4429]), false)
})

test('streams reader frames with bounded send-side backpressure', async () => {
  const peer = new RelayLoadControlPeer(9, peerOptions(), () => undefined)
  let inFlight = 0
  let peakInFlight = 0
  let sentBytes = 0
  const socket = {
    bufferedAmount: 0,
    send(payload, callback) {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      sentBytes += payload.byteLength
      this.bufferedAmount = payload.byteLength
      queueMicrotask(() => {
        this.bufferedAmount = 0
        inFlight--
        callback()
      })
    }
  }

  const result = await peer.sendReaderStream(
    socket,
    0,
    1024 * 1024,
    64 * 1024,
    async () => undefined
  )

  assert.equal(result.bytes, 1024 * 1024)
  assert.equal(sentBytes, 1024 * 1024)
  assert.equal(peakInFlight, 1)
  await peer.shutdown()
})

test('reports a bidirectional splice payload mismatch', async () => {
  const observations = []
  const peer = new RelayLoadControlPeer(2, peerOptions(), (type) => observations.push(type))
  const control = fakeOpenSocket()
  const phone = fakeHandshakeSocket()
  const data = fakeHandshakeSocket()
  control.send = (raw) => {
    const message = JSON.parse(raw)
    queueMicrotask(() =>
      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'invite-created', reqId: message.reqId, inviteToken: 'token' })
        )
      )
    )
  }
  phone.send = (raw) => {
    if (typeof raw === 'string' && raw.startsWith('{') && JSON.parse(raw).type === 'relay-auth') {
      queueMicrotask(() =>
        control.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'conn-open',
              relayDeviceId: 'load-device-2-0',
              connId: 'connection-2',
              connTicket: 'ticket'
            })
          )
        )
      )
    }
  }
  data.send = (raw) => {
    if (typeof raw === 'string') {
      queueMicrotask(() => phone.emit('message', Buffer.from(JSON.stringify({ ok: true })), false))
    } else {
      queueMicrotask(() => phone.emit('message', Buffer.alloc(Buffer.from(raw).byteLength), true))
    }
  }
  peer.socket = control
  peer.generation = 4
  peer.lastAssignment = { cellUrl: 'https://cell.test', assignmentEpoch: 2 }
  control.on('message', (raw) => peer.onMessage(control, raw))
  peer.createClientSocket = () => openOnNextTurn(phone)
  peer.createHostDataSocket = () => openOnNextTurn(data)

  await assert.rejects(peer.openSplice(), /changed host-to-client splice payload/)
  assert.equal(observations.includes('spliceFailed'), true)
  await peer.shutdown()
})

test('shutdown closes both splice legs and waits for the in-flight splice', async () => {
  const spliceOpened = deferred()
  const observations = []
  const peer = new RelayLoadControlPeer(5, peerOptions(), (type, detail) => {
    observations.push({ type, detail })
    if (type === 'spliceOpened') spliceOpened.resolve()
  })
  const control = fakeOpenSocket()
  const phone = fakeHandshakeSocket()
  const data = fakeHandshakeSocket()
  control.send = (raw) => {
    const message = JSON.parse(raw)
    queueMicrotask(() =>
      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'invite-created', reqId: message.reqId, inviteToken: 'token' })
        )
      )
    )
  }
  phone.send = (raw) => {
    if (typeof raw === 'string' && raw.startsWith('{')) {
      queueMicrotask(() =>
        control.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'conn-open',
              relayDeviceId: 'load-device-5-0',
              connId: 'connection-5',
              connTicket: 'ticket'
            })
          )
        )
      )
    } else {
      queueMicrotask(() => data.emit('message', Buffer.from(raw), false))
    }
  }
  data.send = (raw) => {
    if (typeof raw === 'string') {
      queueMicrotask(() => phone.emit('message', Buffer.from(JSON.stringify({ ok: true })), false))
    } else {
      queueMicrotask(() => phone.emit('message', Buffer.from(raw), true))
    }
  }
  peer.socket = control
  peer.generation = 8
  peer.lastAssignment = { cellUrl: 'https://cell.test', assignmentEpoch: 3 }
  control.on('message', (raw) => peer.onMessage(control, raw))
  peer.createClientSocket = () => openOnNextTurn(phone)
  peer.createHostDataSocket = () => openOnNextTurn(data)

  const splice = peer.openSplice({ holdMs: 60_000 })
  await spliceOpened.promise
  await Promise.all([splice, peer.shutdown()])

  assert.equal(phone.readyState, phone.CLOSED)
  assert.equal(data.readyState, data.CLOSED)
  assert.equal(peer.inFlight.size, 0)
  assert.equal(observations.at(-1).type, 'shutdown')
  assert.equal(observations.at(-1).detail.activeSpliceSockets, 0)
})
