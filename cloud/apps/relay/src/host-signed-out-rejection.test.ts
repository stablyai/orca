import { EventEmitter } from 'node:events'
import {
  CONTROL_CONTINUITY_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_HOST_CLOSE_REASON
} from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { HostSessionRegistry } from './host-session-registry.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })
  readonly terminate = vi.fn(() => {
    this.readyState = this.CLOSED
    this.emit('close', 1006, Buffer.alloc(0))
  })
}

const config = {
  port: 8080,
  publicUrl: 'https://relay-c3.example.com',
  cellUrl: 'https://relay-c3.example.com',
  authIssuer: 'https://auth.example.com',
  authAudience: 'orca-relay',
  jwksUrl: 'https://auth.example.com/jwks',
  assignmentSigningKey: new Uint8Array(32),
  role: 'cell',
  cellId: 'production-gce-c3',
  cells: []
} as unknown as RelayConfig

const identity = {
  sub: 'user-1',
  prof: 'profile-1',
  org: 'org-1',
  relayHostId: 'AbCdEf0123_-xyZ9'
} as unknown as RelayTokenClaims

const reservation = {
  userId: identity.sub,
  relayHostId: identity.relayHostId,
  credentialKind: 'resume',
  relayDeviceId: 'device-1',
  leaseExpiresAt: Date.now() + 60_000
}

function createRegistry() {
  const store = {
    resolveResume: vi.fn().mockResolvedValue({ userId: identity.sub }),
    reserveCredential: vi.fn().mockResolvedValue(reservation),
    failReservation: vi.fn().mockResolvedValue(undefined)
  }
  const assignments = {
    activateControl: vi.fn().mockResolvedValue('control:production-gce-c3:1'),
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ cellId: config.cellId }),
    acquireActivity: vi.fn().mockResolvedValue(undefined),
    renewControlActivity: vi.fn().mockResolvedValue(undefined),
    releaseActivity: vi.fn().mockResolvedValue(true)
  } as unknown as RelayAssignmentStore
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordControlClose: vi.fn(),
    recordSpliceClose: vi.fn()
  } satisfies RelayRuntimeObserver
  const registry = new HostSessionRegistry(
    config,
    vi.fn(),
    store as unknown as RelayCredentialStore,
    assignments,
    new ProcessQueuedByteBudget(),
    observer
  )
  const activate = (socket: WebSocket, generation: number): Promise<void> =>
    (
      registry as unknown as {
        activate: (
          socket: WebSocket,
          identity: RelayTokenClaims,
          existing: null,
          generation: number,
          rebind: boolean,
          assignmentEpoch: number,
          appVersion: string
        ) => Promise<void>
      }
    ).activate(socket, identity, null, generation, false, 1, '1.4.173')
  return { registry, activate }
}

async function dialPhone(registry: HostSessionRegistry): Promise<FakeSocket> {
  const phone = new FakeSocket()
  await registry.acceptClient(phone as unknown as WebSocket, identity.relayHostId, 'credential')
  return phone
}

// The 4404 hello body is unchanged: every shipped phone parses it with a strict
// schema, so the cause has to ride the close frame instead.
const HOST_OFFLINE_HELLO = JSON.stringify({
  type: 'relay-hello',
  ok: false,
  code: RELAY_CLOSE_CODE.HOST_OFFLINE
})

describe('host sign-out reason on phone rejection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('names the sign-out to a phone that arrives after the host is gone', async () => {
    const { registry, activate } = createRegistry()
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1)

    const phone = await dialPhone(registry)
    expect(phone.send).toHaveBeenCalledWith(HOST_OFFLINE_HELLO)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
  })

  it('says nothing when the host died without naming a cause', async () => {
    const { registry, activate } = createRegistry()
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.terminate()
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1)

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  it('ignores a close reason the host invented', async () => {
    const { registry, activate } = createRegistry()
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, 'signed-out-ish')
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1)

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  it('forgets the sign-out once the host proves itself again', async () => {
    const { registry, activate } = createRegistry()
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1)

    const reconnected = new FakeSocket()
    await activate(reconnected as unknown as WebSocket, 2)
    // Drop it abruptly, as a network death would, so only the stale memory
    // could still name a cause.
    reconnected.terminate()
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1)

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  // A live host is present: the 4404 there is an attach deadline, not absence.
  it('never names a cause while the host control is connected', async () => {
    const { registry, activate } = createRegistry()
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    const phone = await dialPhone(registry)
    expect(phone.close).not.toHaveBeenCalled()
    expect(control.send).toHaveBeenCalledWith(expect.stringContaining('"type":"conn-open"'))
  })
})
