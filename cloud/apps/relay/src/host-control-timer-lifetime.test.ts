import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  buildHostProofMacInput,
  CONTROL_CONTINUITY_LIMITS,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  HostChallengeSchema,
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

class ControlSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn<(data: string) => void>()
  readonly close = vi.fn((code = 1000, reason = '') => {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason))
  })
  readonly terminate = () => this.close(1006)

  websocket(): WebSocket {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Implements the event, state, and send/close API used by control handshakes.
    return this as unknown as WebSocket
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false)
  }
}

function fixture() {
  const config = loadRelayConfig({
    ORCA_RELAY_PUBLIC_URL: 'https://relay.test',
    ORCA_RELAY_CELL_URL: 'https://relay.test',
    ORCA_RELAY_AUTH_ISSUER: 'https://auth.test',
    ORCA_RELAY_JWKS_URL: 'https://auth.test/jwks',
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'a'.repeat(32),
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://relay.test/v1/admin/drain',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
    ORCA_RELAY_ROLE: 'cell'
  })
  const database: RelayDatabase = {
    query: async () => [],
    queryLocked: async () => [],
    transaction: async (operation) => await operation(database),
    close: async () => undefined
  }
  const assignments = new RelayAssignmentStore(database)
  const verifyAssignment = vi.spyOn(assignments, 'verifyCellAssignment').mockResolvedValue(true)
  vi.spyOn(assignments, 'activateControl').mockResolvedValue('control-activity')
  vi.spyOn(assignments, 'markMigrationTargetRegistered').mockResolvedValue(true)
  vi.spyOn(assignments, 'releaseActivity').mockResolvedValue(true)
  const registry = new HostSessionRegistry(
    config,
    async () => null,
    new RelayCredentialStore(database),
    assignments,
    new ProcessQueuedByteBudget(),
    {
      recordAuth: vi.fn(),
      recordForwardedBytes: vi.fn(),
      recordHttp: vi.fn(),
      recordReconnect: vi.fn(),
      recordSql: vi.fn()
    }
  )
  const keys = nacl.box.keyPair()
  const identity: RelayTokenClaims = {
    sub: 'user-1',
    prof: 'profile-1',
    relayHostId: createHash('sha256').update(keys.publicKey).digest('base64url').slice(0, 16),
    purpose: 'host-control',
    exp: 4_102_444_800
  }
  const hello = (socket: ControlSocket) =>
    socket.message({
      type: 'host-hello',
      v: 1,
      relayHostId: identity.relayHostId,
      assignmentEpoch: 1,
      hostPublicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
      appVersion: 'test'
    })
  const prove = async (socket: ControlSocket) => {
    hello(socket)
    await vi.advanceTimersByTimeAsync(0)
    const frame = socket.send.mock.calls[0]?.[0]
    if (frame === undefined) throw new Error('test challenge was not sent')
    const { type, ...body } = JSON.parse(frame)
    expect(type).toBe('host-challenge')
    const challenge = HostChallengeSchema.parse(body)
    const plaintext = nacl.box.open(
      Buffer.from(challenge.ciphertextB64, 'base64'),
      Buffer.from(challenge.nonceB64, 'base64'),
      Buffer.from(challenge.relayEphemeralPublicKeyB64, 'base64'),
      keys.secretKey
    )
    if (!plaintext) throw new Error('test challenge failed to decrypt')
    const prefixBytes = Buffer.byteLength(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
    const length = Buffer.from(plaintext).readUInt32BE(prefixBytes)
    const transcript = plaintext.slice(prefixBytes + 4, prefixBytes + 4 + length)
    const secret = plaintext.slice(prefixBytes + 4 + length)
    socket.message({
      type: 'host-challenge-ack',
      challengeId: challenge.challengeId,
      proofB64: createHmac('sha256', secret)
        .update(buildHostProofMacInput(transcript))
        .digest('base64')
    })
    await vi.advanceTimersByTimeAsync(0)
  }
  return { registry, identity, hello, prove, verifyAssignment }
}

describe('host control timer lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  for (const phase of ['hello', 'proof']) {
    it(`releases ${phase} waiters when controls close before their next frame`, async () => {
      const { registry, identity, hello } = fixture()
      const retainedTimers: number[] = []
      const retainedFrames: number[] = []
      for (let cycle = 0; cycle < 10; cycle++) {
        const socket = new ControlSocket()
        registry.acceptControl(socket.websocket(), identity)
        if (phase === 'proof') {
          hello(socket)
          await vi.advanceTimersByTimeAsync(0)
          expect(socket.send).toHaveBeenCalledOnce()
        }
        socket.close()
        retainedTimers.push(vi.getTimerCount())
        retainedFrames.push(socket.listenerCount('message'))
      }
      expect(retainedTimers).toEqual(Array(10).fill(0))
      expect(retainedFrames).toEqual(Array(10).fill(0))
    })
  }

  it('does not start a proof wait after assignment verification outlives the socket', async () => {
    const { registry, identity, hello, verifyAssignment } = fixture()
    let finish!: (valid: boolean) => void
    verifyAssignment.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const socket = new ControlSocket()
    registry.acceptControl(socket.websocket(), identity)
    hello(socket)
    socket.close()
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
  })

  it('still rejects controls that remain open past either handshake deadline', async () => {
    const { registry, identity, hello } = fixture()
    const silent = new ControlSocket()
    registry.acceptControl(silent.websocket(), identity)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(silent.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host hello timeout'
    )
    expect(silent.listenerCount('message')).toBe(0)

    const unproven = new ControlSocket()
    registry.acceptControl(unproven.websocket(), identity)
    hello(unproven)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unproven.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host proof timeout'
    )
    expect(unproven.listenerCount('message')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a regional drain deadline when the orphan session expires first', async () => {
    const { registry, identity, prove } = fixture()
    for (let cycle = 0; cycle < 10; cycle++) {
      const socket = new ControlSocket()
      registry.acceptControl(socket.websocket(), identity)
      await prove(socket)
      expect(
        registry.hasActiveControl({ userId: identity.sub, relayHostId: identity.relayHostId })
      ).toBe(true)
      registry.drainHost({
        attemptId: `attempt-${cycle}`,
        userId: identity.sub,
        relayHostId: identity.relayHostId,
        sourceAssignmentEpoch: 1,
        graceMs: 10 * 60_000
      })
      socket.close()
      await vi.advanceTimersByTimeAsync(CONTROL_CONTINUITY_LIMITS.orphanGraceMs)
      expect(registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('cleans successful handshake waits while keeping the control active', async () => {
    const { registry, identity, prove } = fixture()
    const socket = new ControlSocket()
    registry.acceptControl(socket.websocket(), identity)
    await prove(socket)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(
      registry.hasActiveControl({ userId: identity.sub, relayHostId: identity.relayHostId })
    ).toBe(true)
    registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
