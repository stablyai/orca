import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { MobileSocketWiring } from '../../rpc/mobile/mobile-socket-wiring'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
import { deriveRelayHostId, type RelayAssignment } from '../director/relay-http-client'
import { RelayControlOrigin } from './relay-control-origin'

const encoder = new TextEncoder()
const HOST_PROOF_DOMAIN = 'orca-relay-host-proof/v1'
const CHALLENGE_DOMAIN = 'orca-relay-host-challenge/v1'
const RESUMED_GENERATION = 7

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type Hello = { previousGeneration?: number; controlResumeSecret?: string; assignmentEpoch: number }
type PathBehaviour = 'resume' | 'decline-resume' | 'silent'

// One origin (front door or direct edge) reaching the shared fake host session. It speaks the
// edge's control handshake; it does not verify proofs, the client under test is what matters.
class FakeEdgePath {
  readonly connections: WebSocket[] = []
  readonly hellos: Hello[] = []
  readonly acks: string[] = []
  pings = 0
  answersPings = true
  behaviour: PathBehaviour = 'resume'
  // Runs between the host's ack and the hello-ack, as the edge closes the old control at proof.
  beforeHelloAck: (() => Promise<void>) | null = null
  private waiters: ((socket: WebSocket) => void)[] = []
  // Whether each socket's challenge accepted the resume; the generation moves only at proof.
  private readonly resumeBySocket = new Map<WebSocket, boolean>()

  private constructor(
    readonly server: WebSocketServer,
    readonly url: string,
    private readonly session: FakeHostSession
  ) {
    server.on('connection', (socket) => this.accept(socket))
  }

  static async listen(session: FakeHostSession): Promise<FakeEdgePath> {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: false,
      autoPong: false
    })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    return new FakeEdgePath(server, `http://127.0.0.1:${address.port}`, session)
  }

  nextConnection(): Promise<WebSocket> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private accept(socket: WebSocket): void {
    this.connections.push(socket)
    socket.on('ping', () => {
      this.pings += 1
      if (this.answersPings) {
        socket.pong()
      }
    })
    socket.on('message', (raw) => {
      const message: unknown = JSON.parse(raw.toString())
      void this.handle(socket, message)
    })
    for (const waiter of this.waiters.splice(0)) {
      waiter(socket)
    }
  }

  private async handle(socket: WebSocket, message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return
    }
    if (message.type === 'host-hello') {
      const hello: Hello = {
        assignmentEpoch: 'assignmentEpoch' in message ? Number(message.assignmentEpoch) : -1,
        ...('previousGeneration' in message
          ? { previousGeneration: Number(message.previousGeneration) }
          : {}),
        ...('controlResumeSecret' in message
          ? { controlResumeSecret: String(message.controlResumeSecret) }
          : {})
      }
      this.hellos.push(hello)
      if (this.behaviour !== 'silent') {
        socket.send(this.challenge(socket, hello))
      }
      return
    }
    if (message.type === 'host-challenge-ack') {
      this.acks.push('challengeId' in message ? String(message.challengeId) : '')
      await this.beforeHelloAck?.()
      if (!this.resumeBySocket.get(socket)) {
        this.session.generation += 1
      }
      socket.send(this.session.helloAck())
    }
  }

  private challenge(socket: WebSocket, hello: Hello): string {
    const resume =
      this.behaviour === 'resume' &&
      hello.controlResumeSecret !== undefined &&
      hello.controlResumeSecret === this.session.resumeSecret &&
      hello.previousGeneration === this.session.generation
    this.resumeBySocket.set(socket, resume)
    const host = this.session.hostKeys
    const relayKeys = nacl.box.keyPair()
    const nonce = randomBytes(24)
    const challengeId = `challenge-${this.session.challenges++}`
    // Fake clock: the relay's timestamps share the client's frozen Date.
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 10_000
    const transcript = concat([
      field('protocol', encoder.encode(HOST_PROOF_DOMAIN)),
      field('version', new Uint8Array([1])),
      field('relayOrigin', encoder.encode(this.url)),
      field('relayEphemeralPublicKey', relayKeys.publicKey),
      field('challengeNonce', nonce),
      field('challengeId', encoder.encode(challengeId)),
      field('issuedAt', uint64(issuedAt)),
      field('expiresAt', uint64(expiresAt)),
      field('userId', encoder.encode('user-1')),
      field('profileId', encoder.encode('profile-1')),
      field('organizationId', encoder.encode('org-1')),
      field('relayHostId', encoder.encode(this.session.relayHostId)),
      field('hostPublicKey', host.publicKey),
      field('assignmentEpoch', uint64(hello.assignmentEpoch)),
      field(
        'previousGeneration',
        hello.previousGeneration === undefined ? new Uint8Array() : uint64(hello.previousGeneration)
      ),
      field('resumeRequested', new Uint8Array([resume ? 1 : 0]))
    ])
    const plaintext = concat([
      encoder.encode(`${CHALLENGE_DOMAIN}\0`),
      uint32(transcript.byteLength),
      transcript,
      randomBytes(32)
    ])
    return JSON.stringify({
      type: 'host-challenge',
      challengeId,
      relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64'),
      nonceB64: nonce.toString('base64'),
      ciphertextB64: Buffer.from(
        nacl.box(plaintext, nonce, host.publicKey, relayKeys.secretKey)
      ).toString('base64'),
      expiresAt
    })
  }
}

class FakeHostSession {
  generation = RESUMED_GENERATION - 1
  resumeSecret = ''
  challenges = 0
  readonly hostKeys = nacl.box.keyPair()
  readonly relayHostId = deriveRelayHostId(this.hostKeys.publicKey)

  get keypair(): E2EEKeypair {
    return {
      publicKey: this.hostKeys.publicKey,
      secretKey: this.hostKeys.secretKey,
      publicKeyB64: Buffer.from(this.hostKeys.publicKey).toString('base64')
    }
  }

  helloAck(): string {
    this.resumeSecret = randomBytes(32).toString('base64url')
    return JSON.stringify({
      type: 'host-hello-ack',
      v: 1,
      generation: this.generation,
      controlResumeSecret: this.resumeSecret,
      leaseExpiresAt: Date.now() + 6 * 60 * 60_000,
      activeConnIds: [],
      pendingConns: []
    })
  }
}

function closedOnServer(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
}

describe('RelayControlOrigin two-path failover', () => {
  const paths: FakeEdgePath[] = []
  const origins: RelayControlOrigin[] = []
  const wirings: MobileSocketWiring[] = []
  const userDataPaths: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    await Promise.all(origins.splice(0).map((origin) => origin.close()))
    vi.useRealTimers()
    for (const wiring of wirings.splice(0)) {
      wiring.dispose()
    }
    await Promise.all(
      paths.splice(0).map(
        (path) =>
          new Promise<void>((resolve) => {
            for (const socket of path.server.clients) {
              socket.terminate()
            }
            path.server.close(() => resolve())
          })
      )
    )
    for (const path of userDataPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  async function setup(options: { alternates: number }) {
    const session = new FakeHostSession()
    const primary = await FakeEdgePath.listen(session)
    paths.push(primary)
    const alternates: FakeEdgePath[] = []
    for (let index = 0; index < options.alternates; index += 1) {
      const alternate = await FakeEdgePath.listen(session)
      paths.push(alternate)
      alternates.push(alternate)
    }
    const assignment: RelayAssignment = {
      v: 1,
      cellUrl: primary.url,
      assignmentEpoch: 3,
      lease: 'lease',
      ...(alternates.length > 0 ? { alternateCellUrls: alternates.map((path) => path.url) } : {})
    }
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-failover-'))
    userDataPaths.push(userDataPath)
    const wiring = new MobileSocketWiring({
      deviceRegistry: new DeviceRegistry(userDataPath),
      e2eeKeypair: session.keypair,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wirings.push(wiring)
    const closed = deferred<number>()
    const onClose = vi.fn((_origin: RelayControlOrigin, code: number) => closed.resolve(code))
    const onDrain = vi.fn()
    const dataDials: string[] = []
    const origin = new RelayControlOrigin({
      assignment,
      relayJwt: 'scoped-token',
      relayHostId: session.relayHostId,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: session.keypair,
      appVersion: '1.2.3',
      mobileSocketWiring: wiring,
      createDataSocket: (url) => {
        dataDials.push(url)
        throw new Error('test: data dials are only recorded')
      },
      onConnectionOwned: vi.fn(),
      onConnectionReleased: vi.fn(),
      onDrain,
      onDataPathUnhealthy: vi.fn(),
      onClose,
      // No start jitter: the failover dials as soon as the stall is reported.
      random: () => 0
    })
    origins.push(origin)
    const primaryConnection = primary.nextConnection()
    await origin.open()
    const primarySocket = await primaryConnection
    return {
      session,
      primary,
      primarySocket,
      alternates,
      assignment,
      origin,
      onClose,
      onDrain,
      closed: closed.promise,
      dataDials
    }
  }

  // Delivers a conn-open on the server side of the active control to see where data dials go.
  function sendConnOpen(socket: WebSocket, connId: string): void {
    socket.send(
      JSON.stringify({
        type: 'conn-open',
        connId,
        connTicket: randomBytes(32).toString('base64url'),
        kind: 'invite',
        relayDeviceId: 'device-1',
        attachDeadlineMs: 10_000
      })
    )
  }

  it('without alternates keeps today’s liveness: no pings, 75s silence bound, director recovery', async () => {
    const { primary, origin, onClose, closed } = await setup({ alternates: 0 })
    expect(origin.alternateCellUrls).toEqual([])

    await vi.advanceTimersByTimeAsync(89_000)
    expect(primary.pings).toBe(0)
    expect(onClose).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(closed).resolves.toBe(1006)
    expect(primary.pings).toBe(0)
    expect(primary.connections).toHaveLength(1)
  })

  it('resumes the same generation on the alternate when the primary stalls', async () => {
    const { session, primary, primarySocket, alternates, origin, onClose, onDrain, dataDials } =
      await setup({ alternates: 1 })
    const [alternate] = alternates
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    primary.answersPings = false
    // The edge closes the old control 4408 "control rebound" at proof, before the hello-ack.
    alternate.beforeHelloAck = async () => {
      const oldClosed = closedOnServer(primarySocket)
      primarySocket.close(4408, 'control rebound')
      await oldClosed
    }

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(alternate.connections).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(7_000)
    const alternateSocket = await alternateConnection
    await vi.waitFor(() => expect(alternate.acks).toHaveLength(1), { interval: 1 })
    await vi.waitFor(() => expect(origin.hasLiveControl()).toBe(true), { interval: 1 })

    expect(alternate.hellos).toEqual([
      expect.objectContaining({
        previousGeneration: RESUMED_GENERATION,
        controlResumeSecret: expect.any(String)
      })
    ])
    expect(alternate.acks).toHaveLength(1)
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(session.generation).toBe(RESUMED_GENERATION)
    expect(origin.cellUrl).toBe(primary.url)
    // The old control's 4408 "control rebound" is not a dead control: no director recovery.
    expect(onClose).not.toHaveBeenCalled()
    expect(onDrain).not.toHaveBeenCalled()
    expect(primary.connections).toHaveLength(1)

    // Data dials follow the path that proved itself.
    sendConnOpen(alternateSocket, 'conn-after-failover')
    await vi.waitFor(() => expect(dataDials).toHaveLength(1), { interval: 1 })
    expect(dataDials[0]).toBe(
      `${alternate.url.replace('http:', 'ws:')}/v1/host/data/conn-after-failover`
    )
  })

  it('retires the old control itself when the edge’s 4408 has not arrived', async () => {
    const { primary, primarySocket, alternates, origin, onClose } = await setup({ alternates: 1 })
    const [alternate] = alternates
    primary.answersPings = false
    const primaryGone = closedOnServer(primarySocket)

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await alternateConnection
    await primaryGone
    await vi.waitFor(() => expect(origin.hasLiveControl()).toBe(true), { interval: 1 })
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('falls back to director recovery when the alternate declines the resume, without acking', async () => {
    const { session, primary, alternates, origin, onClose, closed } = await setup({
      alternates: 1
    })
    const [alternate] = alternates
    alternate.behaviour = 'decline-resume'
    primary.answersPings = false

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    await alternateConnection

    await expect(closed).resolves.toBe(1006)
    expect(onClose).toHaveBeenCalledOnce()
    expect(session.generation).toBe(RESUMED_GENERATION)
    // A declined resume is never acked, so the failover cannot mint a generation.
    expect(alternate.hellos).toHaveLength(1)
    expect(alternate.acks).toEqual([])
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
  })

  it('falls back to director recovery when the alternate is stalled too', async () => {
    const { primary, alternates, onClose, closed } = await setup({ alternates: 1 })
    const [alternate] = alternates
    alternate.behaviour = 'silent'
    primary.answersPings = false

    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    const alternateSocket = await alternateConnection
    const alternateHello = new Promise<void>((resolve) =>
      alternateSocket.once('message', () => resolve())
    )
    await alternateHello
    expect(onClose).not.toHaveBeenCalled()

    // The alternate's 15s connect deadline expires, then the primary is dropped as today.
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(closed).resolves.toBe(1006)
    expect(onClose).toHaveBeenCalledOnce()
    expect(alternate.acks).toEqual([])
  })

  it('stays on the alternate until rotation dials the primary again', async () => {
    const { session, primary, alternates, assignment, origin, onClose, dataDials } = await setup({
      alternates: 1
    })
    const [alternate] = alternates
    primary.answersPings = false
    const alternateConnection = alternate.nextConnection()
    await vi.advanceTimersByTimeAsync(36_000)
    const alternateSocket = await alternateConnection
    await vi.waitFor(() => expect(alternate.acks).toHaveLength(1), { interval: 1 })
    await vi.waitFor(() => expect(origin.hasLiveControl()).toBe(true), { interval: 1 })

    // The primary recovers and the alternate goes quiet: the host does not flap back.
    primary.answersPings = true
    alternate.answersPings = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(primary.connections).toHaveLength(1)
    expect(alternate.pings).toBe(0)
    expect(onClose).not.toHaveBeenCalled()

    // Lease rotation rebinds on the primary, resuming the same generation.
    const primaryReturn = primary.nextConnection()
    const alternateRetired = closedOnServer(alternateSocket)
    const rebound = origin.rebind('scoped-token', assignment)
    const primarySocket = await primaryReturn
    await rebound
    await alternateRetired
    expect(primary.hellos.at(-1)).toMatchObject({ previousGeneration: RESUMED_GENERATION })
    expect(origin.controlGeneration).toBe(RESUMED_GENERATION)
    expect(session.generation).toBe(RESUMED_GENERATION)
    sendConnOpen(primarySocket, 'conn-after-rotation')
    await vi.waitFor(() => expect(dataDials).toHaveLength(1), { interval: 1 })
    expect(dataDials[0]).toBe(
      `${primary.url.replace('http:', 'ws:')}/v1/host/data/conn-after-rotation`
    )
    // Back on the primary, the stall detector is armed again.
    await vi.advanceTimersByTimeAsync(12_000)
    await vi.waitFor(() => expect(primary.pings).toBeGreaterThan(0), { interval: 1 })
  })
})
