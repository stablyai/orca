import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../shared/mobile-relay-close-codes'
import { RelayControlClient } from './relay-control-client'

const encoder = new TextEncoder()

/** A JSON control frame, including the forward-compat frames the client must ignore. */
type ControlFrame = { type: string } & Record<string, unknown>
const HOST_PROOF_DOMAIN = 'orca-relay-host-proof/v1'
const CHALLENGE_DOMAIN = 'orca-relay-host-challenge/v1'

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

function field(name: string, value: Uint8Array): Uint8Array {
  const encodedName = encoder.encode(name)
  return concat([uint32(encodedName.byteLength), encodedName, uint32(value.byteLength), value])
}

function text(value: string): Uint8Array {
  return encoder.encode(value)
}

function buildTranscript(input: {
  origin: string
  relayKey: Uint8Array
  nonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  relayHostId: string
  hostKey: Uint8Array
}): Uint8Array {
  return concat([
    field('protocol', text(HOST_PROOF_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('relayOrigin', text(input.origin)),
    field('relayEphemeralPublicKey', input.relayKey),
    field('challengeNonce', input.nonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('userId', text('user-1')),
    field('profileId', text('profile-1')),
    field('organizationId', text('org-1')),
    field('relayHostId', text(input.relayHostId)),
    field('hostPublicKey', input.hostKey),
    field('assignmentEpoch', uint64(3)),
    field('previousGeneration', new Uint8Array()),
    field('resumeRequested', new Uint8Array([0]))
  ])
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
  })
}

describe('RelayControlClient', () => {
  const servers: WebSocketServer[] = []
  const clients: RelayControlClient[] = []
  /** Raw TCP listeners that accept but never upgrade; they have no WebSocketServer to close. */
  const silentServers: Server[] = []
  const silentSockets: Socket[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.closeNow()
    }
    for (const socket of silentSockets.splice(0)) {
      socket.destroy()
    }
    await Promise.all(
      silentServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          })
      )
    )
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) {
              socket.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  it('rejects a control handshake that never receives a proof response', async () => {
    // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const keypair = nacl.box.keyPair()
    const client = new RelayControlClient({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayJwt: 'scoped-token',
      relayHostId: createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16),
      assignmentEpoch: 1,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: {
        ...keypair,
        publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
      },
      appVersion: '1.2.3',
      onConnectionOpen: vi.fn(),
      onDrain: vi.fn(),
      onClose: vi.fn(),
      connectDeadlineMs: 20
    })
    clients.push(client)

    await expect(client.connect()).rejects.toThrow('relay_control_connect_timeout')
  })

  // Why: the connect deadline is armed in the same tick as the socket and expires from
  // 'opening' too, so it already bounds a connect that never opens. Without this a reader
  // concludes the phase is uncovered and adds a second, transport-level bound for it.
  it('expires a connect whose upgrade is never answered', async () => {
    const server = createServer((socket) => {
      silentSockets.push(socket)
    })
    silentServers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const keypair = nacl.box.keyPair()
    const client = new RelayControlClient({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayJwt: 'scoped-token',
      relayHostId: createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16),
      assignmentEpoch: 1,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
      appVersion: '1.2.3',
      onConnectionOpen: vi.fn(),
      onDrain: vi.fn(),
      onClose: vi.fn(),
      connectDeadlineMs: 150
    })
    clients.push(client)

    await expect(client.connect()).rejects.toThrow('relay_control_connect_timeout')
  })

  it('settles an opening control immediately when ownership closes', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const keypair = nacl.box.keyPair()
    const client = new RelayControlClient({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayJwt: 'scoped-token',
      relayHostId: createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16),
      assignmentEpoch: 1,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: {
        ...keypair,
        publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
      },
      appVersion: '1.2.3',
      onConnectionOpen: vi.fn(),
      onDrain: vi.fn(),
      onClose: vi.fn()
    })
    clients.push(client)
    const accepted = new Promise<void>((resolve) => {
      server.once('connection', () => resolve())
    })
    const connecting = client.connect()

    await accepted
    client.closeNow()

    await expect(connecting).rejects.toThrow('relay_control_closed')
  })

  it('proves the host key and drives control/data commands without URL credentials', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const origin = `http://127.0.0.1:${address.port}`
    const hostKeys = nacl.box.keyPair()
    const keypair: E2EEKeypair = {
      publicKey: hostKeys.publicKey,
      secretKey: hostKeys.secretKey,
      publicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64')
    }
    const relayHostId = createHash('sha256')
      .update(hostKeys.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const accepted = new Promise<{
      socket: WebSocket
      authorization: string
      capabilities: string
      path: string
    }>((resolve) => {
      server.once('connection', (socket, request) =>
        resolve({
          socket,
          authorization: String(request.headers.authorization),
          capabilities: String(request.headers['x-orca-host-capabilities']),
          path: request.url ?? ''
        })
      )
    })
    const onConnectionOpen = vi.fn()
    const onDrain = vi.fn()
    const onClose = vi.fn()
    const client = new RelayControlClient({
      cellUrl: origin,
      relayJwt: 'scoped-token',
      relayHostId,
      assignmentEpoch: 3,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair,
      appVersion: '1.2.3',
      onConnectionOpen,
      onDrain,
      onClose
    })
    clients.push(client)
    const connecting = client.connect()
    const { socket, authorization, capabilities, path } = await accepted
    expect(authorization).toBe('Bearer scoped-token')
    // Advertised on the upgrade, never in host-hello: a cell that predates the
    // capability parses host-hello strictly and would refuse the handshake.
    expect(capabilities).toBe('pending-conn-details,idle-regional-rehome-v1')
    expect(path).toBe('/v1/host/control')
    const hello = await nextJson(socket)
    expect(hello).toMatchObject({
      type: 'host-hello',
      relayHostId,
      assignmentEpoch: 3,
      hostPublicKeyB64: keypair.publicKeyB64
    })

    const relayKeys = nacl.box.keyPair()
    const nonce = randomBytes(24)
    const secret = randomBytes(32)
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 10_000
    const transcript = buildTranscript({
      origin,
      relayKey: relayKeys.publicKey,
      nonce,
      challengeId: 'challenge-1',
      issuedAt,
      expiresAt,
      relayHostId,
      hostKey: hostKeys.publicKey
    })
    const plaintext = concat([
      text(`${CHALLENGE_DOMAIN}\0`),
      uint32(transcript.byteLength),
      transcript,
      secret
    ])
    const proofMessage = nextJson(socket)
    socket.send(
      JSON.stringify({
        type: 'host-challenge',
        challengeId: 'challenge-1',
        relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64'),
        nonceB64: nonce.toString('base64'),
        ciphertextB64: Buffer.from(
          nacl.box(plaintext, nonce, hostKeys.publicKey, relayKeys.secretKey)
        ).toString('base64'),
        expiresAt
      })
    )
    const proof = await proofMessage
    expect(proof).toMatchObject({ type: 'host-challenge-ack', challengeId: 'challenge-1' })
    const expectedProof = createHmac('sha256', secret)
      .update(text(`${HOST_PROOF_DOMAIN}\0ack\0`))
      .update(transcript)
      .digest('base64')
    expect(proof.proofB64).toBe(expectedProof)

    socket.send(
      JSON.stringify({
        type: 'host-hello-ack',
        v: 1,
        generation: 4,
        controlResumeSecret: randomBytes(32).toString('base64url'),
        leaseExpiresAt: Date.now() + 60_000,
        activeConnIds: [],
        pendingConns: []
      })
    )
    await expect(connecting).resolves.toMatchObject({ generation: 4 })

    socket.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    await expect(nextJson(socket)).resolves.toMatchObject({ type: 'pong' })
    socket.send(
      JSON.stringify({
        type: 'conn-open',
        connId: 'conn-1',
        connTicket: randomBytes(32).toString('base64url'),
        kind: 'invite',
        relayDeviceId: 'device-1',
        attachDeadlineMs: 10_000
      })
    )
    await vi.waitFor(() => expect(onConnectionOpen).toHaveBeenCalledOnce())

    const inviteRequest = nextJson(socket)
    const invitePromise = client.createInvite('device-1', 'invite-req')
    await expect(inviteRequest).resolves.toEqual({
      type: 'invite-create',
      reqId: 'invite-req',
      relayDeviceId: 'device-1'
    })
    socket.send(
      JSON.stringify({
        type: 'invite-created',
        reqId: 'invite-req',
        inviteToken: randomBytes(32).toString('base64url'),
        expiresAt: Date.now() + 60_000,
        maxAttempts: 3
      })
    )
    await expect(invitePromise).resolves.toMatchObject({ reqId: 'invite-req' })

    const installRequest = nextJson(socket)
    const installPromise = client.installCredential({
      reqId: 'install-req',
      relayDeviceId: 'device-1',
      newResumeTokenHash: 'A'.repeat(43),
      authorization: { mode: 'relay-basis', basisConnId: 'conn-1' }
    })
    await expect(installRequest).resolves.toEqual({
      type: 'device-credential-install',
      v: 1,
      reqId: 'install-req',
      relayDeviceId: 'device-1',
      newResumeTokenHash: 'A'.repeat(43),
      authorization: { mode: 'relay-basis', basisConnId: 'conn-1' }
    })
    socket.send(
      JSON.stringify({
        type: 'device-credential-installed',
        v: 1,
        reqId: 'install-req',
        authorizationMode: 'relay-basis',
        currentVersion: 1,
        resumeExpiresAt: Date.now() + 60_000
      })
    )
    await expect(installPromise).resolves.toMatchObject({ currentVersion: 1 })

    const statusRequest = nextJson(socket)
    const statusPromise = client.credentialInstallStatus('device-1', 'install-req')
    await expect(statusRequest).resolves.toEqual({
      type: 'device-credential-install-status',
      v: 1,
      reqId: 'install-req',
      relayDeviceId: 'device-1'
    })
    socket.send(
      JSON.stringify({
        type: 'device-credential-install-status-result',
        v: 1,
        reqId: 'install-req',
        state: 'not-found'
      })
    )
    await expect(statusPromise).resolves.toMatchObject({ state: 'not-found' })

    const confirmationRequest = nextJson(socket)
    const confirmationPromise = client.confirmResume('conn-2', 'confirm-req')
    await expect(confirmationRequest).resolves.toEqual({
      type: 'device-resume-confirm',
      v: 1,
      reqId: 'confirm-req',
      basisConnId: 'conn-2'
    })
    socket.send(
      JSON.stringify({
        type: 'device-resume-confirmed',
        v: 1,
        reqId: 'confirm-req',
        currentVersion: 1,
        acceptedAs: 'current',
        renewed: true,
        resumeExpiresAt: Date.now() + 60_000
      })
    )
    await expect(confirmationPromise).resolves.toMatchObject({ renewed: true })

    socket.send(JSON.stringify({ type: 'drain', graceMs: 5_000, recovery: 'resolve-director' }))
    await vi.waitFor(() => expect(onDrain).toHaveBeenCalledOnce())
  })
})

class FakeControlSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  script: ((message: Record<string, unknown>, socket: FakeControlSocket) => void) | null = null

  send(payload: string): void {
    this.script?.(JSON.parse(payload) as Record<string, unknown>, this)
  }

  close(code = 1000): void {
    if (this.readyState !== 1) {
      return
    }
    this.readyState = 3
    this.emit('close', code)
  }

  terminate(): void {
    this.close(1006)
  }

  pings = 0

  ping(): void {
    if (this.readyState !== 1) {
      throw new Error('socket_not_open')
    }
    this.pings += 1
  }

  /** The RFC 6455 reply a live peer owes any ping, delivered out of band. */
  pong(): void {
    this.emit('pong')
  }

  deliver(message: ControlFrame): void {
    this.emit('message', JSON.stringify(message), false)
  }
}

function scriptedControl(
  options: {
    closeWithAck?: boolean
    issuedAtOffsetMs?: number
    livenessRandom?: () => number
  } = {}
): {
  client: RelayControlClient
  socket: FakeControlSocket
  onConnectionOpen: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const hostKeys = nacl.box.keyPair()
  const keypair: E2EEKeypair = {
    publicKey: hostKeys.publicKey,
    secretKey: hostKeys.secretKey,
    publicKeyB64: Buffer.from(hostKeys.publicKey).toString('base64')
  }
  const origin = 'http://relay.test'
  const relayHostId = createHash('sha256')
    .update(hostKeys.publicKey)
    .digest('base64url')
    .slice(0, 16)
  const socket = new FakeControlSocket()
  socket.script = (message, ws) => {
    if (message.type === 'host-hello') {
      const relayKeys = nacl.box.keyPair()
      const nonce = randomBytes(24)
      const secret = randomBytes(32)
      const issuedAt = Date.now() + (options.issuedAtOffsetMs ?? 0)
      const expiresAt = issuedAt + 10_000
      const transcript = buildTranscript({
        origin,
        relayKey: relayKeys.publicKey,
        nonce,
        challengeId: 'challenge-1',
        issuedAt,
        expiresAt,
        relayHostId,
        hostKey: hostKeys.publicKey
      })
      const plaintext = concat([
        text(`${CHALLENGE_DOMAIN}\0`),
        uint32(transcript.byteLength),
        transcript,
        secret
      ])
      ws.deliver({
        type: 'host-challenge',
        challengeId: 'challenge-1',
        relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64'),
        nonceB64: nonce.toString('base64'),
        ciphertextB64: Buffer.from(
          nacl.box(plaintext, nonce, hostKeys.publicKey, relayKeys.secretKey)
        ).toString('base64'),
        expiresAt
      })
      return
    }
    if (message.type === 'host-challenge-ack') {
      ws.deliver({
        type: 'host-hello-ack',
        v: 1,
        generation: 4,
        controlResumeSecret: randomBytes(32).toString('base64url'),
        leaseExpiresAt: Date.now() + 3_600_000,
        activeConnIds: [],
        pendingConns: []
      })
      // Same ws parser turn: the close event fires before any awaiting caller
      // of connect() gets to run.
      if (options.closeWithAck) {
        ws.close(1006)
      }
    }
  }
  const onClose = vi.fn()
  const onConnectionOpen = vi.fn()
  const client = new RelayControlClient({
    cellUrl: origin,
    // Midpoint random => no jitter, so probe boundaries are exact in tests.
    livenessRandom: options.livenessRandom ?? (() => 0.5),
    relayJwt: 'scoped-token',
    relayHostId,
    assignmentEpoch: 3,
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair,
    appVersion: '1.2.3',
    onConnectionOpen,
    onDrain: vi.fn(),
    onClose,
    createSocket: () => socket as unknown as WebSocket
  })
  queueMicrotask(() => socket.emit('open'))
  return { client, socket, onConnectionOpen, onClose }
}

describe('RelayControlClient scripted-socket lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves connect when close lands in the ack parser turn, but reports not live', async () => {
    const { client, onClose } = scriptedControl({ closeWithAck: true })

    await expect(client.connect()).resolves.toMatchObject({ generation: 4 })

    expect(onClose).toHaveBeenCalledWith(1006)
    expect(client.isLive()).toBe(false)
  })

  it('tolerates a cell clock slightly ahead when validating the challenge', async () => {
    // A relay whose clock runs ~100ms-2s ahead is normal NTP drift, not replay.
    const { client } = scriptedControl({ issuedAtOffsetMs: 1_500 })

    await expect(client.connect()).resolves.toMatchObject({ generation: 4 })
    expect(client.isLive()).toBe(true)
  })

  it('rejects a challenge issued beyond the clock tolerance', async () => {
    const { client } = scriptedControl({ issuedAtOffsetMs: 45_000 })

    await expect(client.connect()).rejects.toThrow('invalid host challenge')
    expect(client.isLive()).toBe(false)
  })

  it('terminates a silent control after the silence limit and reports closure', async () => {
    vi.useFakeTimers()
    const { client, socket, onClose } = scriptedControl()
    await expect(client.connect()).resolves.toMatchObject({ generation: 4 })
    expect(client.isLive()).toBe(true)

    vi.advanceTimersByTime(91_000)

    expect(socket.readyState).toBe(3)
    expect(onClose).toHaveBeenCalledWith(1006)
    expect(client.isLive()).toBe(false)
  })

  it('keeps a control live while server pings keep arriving', async () => {
    vi.useFakeTimers()
    const { client, socket } = scriptedControl()
    await client.connect()

    for (let round = 0; round < 6; round++) {
      vi.advanceTimersByTime(60_000)
      socket.deliver({ type: 'ping', t: Date.now() })
    }
    expect(client.isLive()).toBe(true)

    vi.advanceTimersByTime(91_000)
    expect(client.isLive()).toBe(false)
  })

  it('ignores an unrecognized control message without closing the active control', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, socket, onClose } = scriptedControl()
    await client.connect()
    expect(client.isLive()).toBe(true)

    // A newer relay opcode the desktop schema does not know. Rule 2 of
    // remote-wire-compatibility: an unknown-but-well-formed frame is dropped,
    // never fatal to a live control.
    socket.deliver({ type: 'relay-hint', v: 2, hint: 'future-feature' })

    expect(client.isLive()).toBe(true)
    expect(socket.readyState).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores a reply whose request already timed out instead of self-closing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, socket, onClose } = scriptedControl()
    await client.connect()

    // A relay control-error carrying a reqId with no live waiter — e.g. a late
    // reply that arrived after the desktop's request deadline deleted it, or the
    // relay's no-op error for a command it could not route. Must not be fatal.
    socket.deliver({ type: 'control-error', reqId: 'expired-req', code: 'unknown_control_message' })

    expect(client.isLive()).toBe(true)
    expect(socket.readyState).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still opens a connection the relay handed over before it asked us to drain', async () => {
    const { client, socket, onConnectionOpen } = scriptedControl()
    await client.connect()
    socket.deliver({ type: 'drain', graceMs: 5_000, recovery: 'resolve-director' })

    // A drain-only cell refuses new phones, so this conn-open was issued before
    // the drain and only this cell holds the phone waiting on it.
    socket.deliver({
      type: 'conn-open',
      connId: 'conn-1',
      connTicket: 'T'.repeat(43),
      kind: 'resume',
      relayDeviceId: 'device-1',
      attachDeadlineMs: 10_000
    })

    expect(onConnectionOpen).toHaveBeenCalledOnce()
    expect(onConnectionOpen).toHaveBeenCalledWith(
      expect.objectContaining({ connId: 'conn-1', connTicket: 'T'.repeat(43) })
    )
    expect(client.isLive()).toBe(true)
  })

  it('still tears down a malformed (non-JSON) control frame', async () => {
    const { client, socket, onClose } = scriptedControl()
    await client.connect()

    socket.emit('message', 'not-json{', false)

    expect(client.isLive()).toBe(false)
    expect(socket.readyState).toBe(3)
    expect(onClose).toHaveBeenCalledWith(MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
  })
})

// STA-7672: a Windows desktop behind NAT/VPN (or resuming from sleep) can hold a
// half-open control socket that send() writes into happily while nothing comes
// back. Every pairing request then failed at its 10s deadline against a socket
// the 75s silence watchdog would not reap for another minute-plus.
describe('RelayControlClient half-open recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tears down only after a run of unanswered probes, not the first one', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, socket, onClose } = scriptedControl()
    await client.connect()
    const invite = client.createInvite('device-1').catch((error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(10_000)

    // The request deadline alone must not close the control — a close would have
    // rejected as relay_control_closed_<code> instead.
    expect(await invite).toBe('relay_control_request_timeout')
    expect(socket.pings).toBe(1)
    expect(socket.readyState).toBe(1)

    // One unanswered probe is UNKNOWN, not death (STA-3320): a lone swallowed
    // pong is routine on exactly the VPN/cellular paths this detection targets.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.pings).toBe(2)
    expect(socket.readyState).toBe(1)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.pings).toBe(3)
    expect(socket.readyState).toBe(1)

    // Third consecutive miss is evidence.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.readyState).toBe(3)
    expect(onClose).toHaveBeenCalledWith(1006)
    expect(client.isLive()).toBe(false)
    // Named in the log so a fleet-wide false positive would be visible.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=probe-unanswered'))
    warn.mockRestore()
  })

  it('retires the whole probe run on a single pong', async () => {
    vi.useFakeTimers()
    const { client, socket, onClose } = scriptedControl()
    await client.connect()
    const invite = client.createInvite('device-1').catch((error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(10_000)
    await invite
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.pings).toBe(2)
    socket.pong()

    // A later probe run must start from zero, not inherit the earlier miss.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(socket.readyState).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(client.isLive()).toBe(true)
  })

  it("clears an armed probe on the relay's next ping, with no pong involved", async () => {
    vi.useFakeTimers()
    const { client, socket, onClose } = scriptedControl()
    await client.connect()
    const invite = client.createInvite('device-1').catch((error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.pings).toBe(1)
    await invite

    // The probe run (3 x 8s) outlasts the relay's 15s ping cadence on purpose:
    // relay liveness runs at the application layer, so a middlebox that swallows
    // RFC 6455 control frames must not be able to make this a reconnect loop.
    await vi.advanceTimersByTimeAsync(15_000)
    socket.deliver({ type: 'ping', t: Date.now() })
    await vi.advanceTimersByTimeAsync(40_000)

    expect(socket.readyState).toBe(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(client.isLive()).toBe(true)
  })

  it('does not probe a control that kept talking while a request went unanswered', async () => {
    vi.useFakeTimers()
    const { client, socket } = scriptedControl()
    await client.connect()
    const invite = client.createInvite('device-1').catch((error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(5_000)
    socket.deliver({ type: 'ping', t: Date.now() })
    await vi.advanceTimersByTimeAsync(5_000)

    // A reply running past its deadline under relay DB load is not a dead
    // socket; tearing this control down would strand every phone on the cell.
    expect(await invite).toBe('relay_control_request_timeout')
    expect(socket.pings).toBe(0)
    expect(client.isLive()).toBe(true)
  })

  it('spreads probe deadlines so one slow cell cannot synchronize a cohort', async () => {
    vi.useFakeTimers()
    // Earliest jitter (-10%) fires at 7.2s; the unjittered boundary is 8s.
    const { client, socket } = scriptedControl({ livenessRandom: () => 0 })
    await client.connect()
    void client.createInvite('device-1').catch(() => undefined)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.pings).toBe(1)
    await vi.advanceTimersByTimeAsync(7_300)
    expect(socket.pings).toBe(2)
  })

  it('logs the cell and the silence without altering the rejection', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = scriptedControl()
    await client.connect()
    const invite = client.createInvite('device-1').catch((error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(10_000)

    // The message is a classification key: mobile-relay-mint-failure.ts matches
    // it against an anchored /^relay_[a-z0-9_]{1,74}$/, so a diagnostic suffix
    // silently downgrades this to the generic relay_mint_failed fallback.
    expect(await invite).toBe('relay_control_request_timeout')

    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('reqKind=invite')
    expect(logged).toContain('cell=http://relay.test')
    expect(logged).toContain('socketAgeMs=10000')
    expect(logged).toContain('sinceInboundMs=10000')
    expect(logged).toContain('probe=armed')
    warn.mockRestore()
  })
})
