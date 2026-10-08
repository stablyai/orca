import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  buildHostProofMacInput,
  HostChallengeSchema,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  RELAY_CLOSE_CODE
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { RelayAssignmentStore } from './assignment-store.js'
import { loadRelayConfig } from './config.js'
import { RelayCredentialStore } from './credential-store.js'
import type { RelayDatabase } from './database.js'
import { HostSessionRegistry } from './host-session-registry.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

class ProofSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn<(frame: string) => void>()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })

  peerClose(): void {
    this.readyState = this.CLOSED
    this.emit('close', 1000, Buffer.alloc(0))
  }

  registrySocket(): WebSocket {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake implements the registry's send, state, close and EventEmitter surface; no actual networking is invoked.
    return this as unknown as WebSocket
  }
}

function fixture() {
  const database: RelayDatabase = {
    query: vi.fn(async () => []),
    queryLocked: vi.fn(async () => []),
    transaction: (operation) => operation(database),
    close: async () => undefined
  }
  const config = loadRelayConfig({
    ORCA_RELAY_PUBLIC_URL: 'http://127.0.0.1',
    ORCA_RELAY_CELL_URL: 'http://127.0.0.1',
    ORCA_RELAY_AUTH_ISSUER: 'https://auth.example.test',
    ORCA_RELAY_JWKS_URL: 'https://auth.example.test/jwks',
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'synthetic-assignment-key-for-test-only',
    ORCA_RELAY_ROLE: 'cell',
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://auth.example.test/admin',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
    ORCA_RELAY_CELL_CONNECTION_HARD_CAP: '600',
    ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND: '60'
  })
  const assignments = new RelayAssignmentStore(database)
  const verify = vi.spyOn(assignments, 'verifyCellAssignment').mockResolvedValue(true)
  const activate = vi.spyOn(assignments, 'activateControl').mockResolvedValue('control:1')
  vi.spyOn(assignments, 'markMigrationTargetRegistered').mockResolvedValue(true)
  const recordAuth = vi.fn()
  const registry = new HostSessionRegistry(
    config,
    async () => null,
    new RelayCredentialStore(database),
    assignments,
    new ProcessQueuedByteBudget(),
    {
      recordAuth,
      recordForwardedBytes: vi.fn(),
      recordHttp: vi.fn(),
      recordReconnect: vi.fn(),
      recordSql: vi.fn()
    }
  )
  const keyPair = nacl.box.keyPair()
  const identity = {
    sub: 'user-proof',
    prof: 'profile-proof',
    relayHostId: createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16),
    purpose: 'host-control',
    exp: Math.floor(Date.now() / 1000) + 3600
  } satisfies RelayTokenClaims
  const hello = JSON.stringify({
    type: 'host-hello',
    v: 1,
    relayHostId: identity.relayHostId,
    assignmentEpoch: 1,
    hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
    appVersion: 'test'
  })
  return { registry, verify, activate, recordAuth, database, identity, keyPair, hello }
}

async function openProof(h: ReturnType<typeof fixture>, socket = new ProofSocket()) {
  h.registry.acceptControl(socket.registrySocket(), h.identity)
  socket.emit('message', Buffer.from(h.hello), false)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.verify).toHaveBeenCalled()
  expect(socket.send).toHaveBeenCalledOnce()
  return socket
}

function answerProof(socket: ProofSocket, keyPair: nacl.BoxKeyPair): void {
  const frame = socket.send.mock.calls[0]?.[0]
  if (frame === undefined) {
    throw new Error('missing challenge')
  }
  const parsed: unknown = JSON.parse(frame)
  if (parsed === null || typeof parsed !== 'object' || !('type' in parsed)) {
    throw new Error('invalid challenge frame')
  }
  const { type, ...fields } = parsed
  expect(type).toBe('host-challenge')
  const challenge = HostChallengeSchema.parse(fields)
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.relayEphemeralPublicKeyB64, 'base64'),
    keyPair.secretKey
  )
  if (plaintext === null) {
    throw new Error('challenge did not decrypt')
  }
  const domain = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
  expect(plaintext.subarray(0, domain.length)).toEqual(domain)
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domain.length,
    4
  ).getUint32(0, false)
  const transcriptStart = domain.length + 4
  const transcript = plaintext.subarray(transcriptStart, transcriptStart + transcriptLength)
  const secret = plaintext.subarray(transcriptStart + transcriptLength)
  const proofB64 = createHmac('sha256', secret)
    .update(buildHostProofMacInput(transcript))
    .digest('base64')
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'host-challenge-ack', challengeId: challenge.challengeId, proofB64 })
    ),
    false
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host control proof cleanup', () => {
  it('allocates no hello stage for an already closed peer', () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.peerClose()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.verify).not.toHaveBeenCalled()
  })

  it('releases the host hello timer and listeners when its peer closes early', () => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    expect(vi.getTimerCount()).toBe(1)
    expect(socket.listenerCount('message')).toBe(1)
    socket.peerClose()
    expect({
      timers: vi.getTimerCount(),
      message: socket.listenerCount('message'),
      close: socket.listenerCount('close')
    }).toEqual({ timers: 0, message: 0, close: 0 })
    vi.advanceTimersByTime(2000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
  })

  it('preserves the exact hello deadline and refusal while releasing its message listener', () => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    vi.advanceTimersByTime(1999)
    expect(socket.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host hello timeout'
    )
    expect(socket.listenerCount('message')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the challenge timer and listeners when its peer closes before proof', async () => {
    const h = fixture()
    const socket = await openProof(h)
    expect(vi.getTimerCount()).toBe(1)
    expect(socket.listenerCount('message')).toBe(1)
    socket.peerClose()
    expect({
      timers: vi.getTimerCount(),
      message: socket.listenerCount('message'),
      close: socket.listenerCount('close')
    }).toEqual({ timers: 0, message: 0, close: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
  })

  it('preserves the exact proof deadline and refusal with no leftover listener', async () => {
    const h = fixture()
    const socket = await openProof(h)
    await vi.advanceTimersByTimeAsync(9999)
    expect(socket.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host proof timeout'
    )
    expect(socket.listenerCount('message')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.recordAuth).not.toHaveBeenCalled()
  })

  it('does no challenge crypto, send, timer or registration after a closed peer finishes verification', async () => {
    const h = fixture()
    let finish!: (valid: boolean) => void
    h.verify.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const generateKey = vi.spyOn(nacl.box, 'keyPair')
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from(h.hello), false)
    expect(h.verify).toHaveBeenCalledOnce()
    socket.peerClose()
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.send).not.toHaveBeenCalled()
    expect(generateKey).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
    expect(h.database.query).not.toHaveBeenCalled()
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })
    ).toBeNull()
  })

  it.each([false, true])('preserves invalid first-frame refusal (binary=%s)', (binary) => {
    const h = fixture()
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from('{}'), binary)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      binary ? 'host hello must be text' : 'invalid host hello'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves invalid proof authentication failure (binary=%s)',
    async (binary) => {
      const h = fixture()
      const socket = await openProof(h)
      socket.emit('message', Buffer.from('{}'), binary)
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(
        RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
        'invalid host proof'
      )
      expect(h.recordAuth).toHaveBeenCalledExactlyOnceWith(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(socket.listenerCount('close')).toBe(0)
      expect(h.activate).not.toHaveBeenCalled()
    }
  )

  it('allocates no proof wait when sending the challenge closes its peer', async () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.send.mockImplementation(() => socket.peerClose())
    await openProof(h, socket)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(h.activate).not.toHaveBeenCalled()
  })

  it('keeps the existing diagnostic and refusal when challenge send throws', async () => {
    const h = fixture()
    const socket = new ProofSocket()
    socket.send.mockImplementation(() => {
      throw new Error('synthetic send failure')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await openProof(h, socket)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'relay temporarily unavailable'
    )
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[orca-relay] host hello proof failed: synthetic send failure'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })

  it('contains assignment lookup rejection with its existing close and diagnostic', async () => {
    const h = fixture()
    h.verify.mockRejectedValueOnce(new Error('synthetic lookup failure'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from(h.hello), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'relay temporarily unavailable'
    )
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[orca-relay] host hello proof failed: synthetic lookup failure'
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })

  it('keeps a newer same-host peer live when the old proof peer closes', async () => {
    const h = fixture()
    const oldPeer = await openProof(h)
    const replacement = await openProof(h)
    oldPeer.peerClose()
    expect(vi.getTimerCount()).toBe(1)
    answerProof(replacement, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.activate).toHaveBeenCalledOnce()
    expect(h.recordAuth).toHaveBeenCalledExactlyOnceWith(true)
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })?.socket
    ).toBe(replacement)
    expect(replacement.send).toHaveBeenCalledTimes(2)
    expect(replacement.listenerCount('message')).toBe(1)
    expect(replacement.listenerCount('close')).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(oldPeer.close).not.toHaveBeenCalled()
    expect(replacement.close).not.toHaveBeenCalled()
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
