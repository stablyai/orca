import { randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
import { deriveRelayHostId } from '../director/relay-http-client'

// Loopback fake of the relay edge's host control handshake, shared by the two-path tests.
const encoder = new TextEncoder()
const HOST_PROOF_DOMAIN = 'orca-relay-host-proof/v1'
const CHALLENGE_DOMAIN = 'orca-relay-host-challenge/v1'
export const RESUMED_GENERATION = 7

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

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export type Hello = {
  previousGeneration?: number
  controlResumeSecret?: string
  assignmentEpoch: number
}
type PathBehaviour = 'resume' | 'decline-resume' | 'silent'

// One origin (front door or direct edge) reaching the shared fake host session. It speaks the
// edge's control handshake; it does not verify proofs, the client under test is what matters.
export class FakeEdgePath {
  readonly connections: WebSocket[] = []
  readonly hellos: Hello[] = []
  readonly acks: string[] = []
  // Tokens the host sent in auth-refresh frames on this path.
  readonly authRefreshes: string[] = []
  // The bearer token each control connection dialled with.
  readonly dialTokens: string[] = []
  pings = 0
  answersPings = true
  behaviour: PathBehaviour = 'resume'
  // Runs between the host's ack and the hello-ack, as the edge closes the old control at proof.
  beforeHelloAck: (() => Promise<void>) | null = null
  challengeGate: Promise<void> | null = null
  private waiters: ((socket: WebSocket) => void)[] = []
  // Whether each socket's challenge accepted the resume; the generation moves only at proof.
  private readonly resumeBySocket = new Map<WebSocket, boolean>()

  private constructor(
    readonly server: WebSocketServer,
    readonly url: string,
    private readonly session: FakeHostSession
  ) {
    server.on('connection', (socket, request) => {
      this.dialTokens.push(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
      this.accept(socket)
    })
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
      // A slow path: the challenge (the edge's first frame) waits on the gate.
      if (this.challengeGate) {
        await this.challengeGate
      }
      if (this.behaviour !== 'silent' && socket.readyState === socket.OPEN) {
        socket.send(this.challenge(socket, hello))
      }
      return
    }
    if (message.type === 'auth-refresh') {
      this.authRefreshes.push('relayJwt' in message ? String(message.relayJwt) : '')
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

export class FakeHostSession {
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

export function closedOnServer(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
}

// Waits on loopback I/O with the fake clock held still: vi.waitFor advances it every poll and gives
// up after 1s of wall time, so a slow CI runner fails it while the handshake is still in flight.
export async function untilLoopback(check: () => void, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (performance.now() > deadline) {
        throw error
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
