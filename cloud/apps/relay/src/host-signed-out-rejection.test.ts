import { EventEmitter } from 'node:events'
import {
  CONTROL_CONTINUITY_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_HOST_CLOSE_REASON
} from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig, RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
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

const CELLS: RelayCellConfig[] = [
  { id: 'production-gce-c3', url: 'https://relay-c3.example.com', capacityRequests: 64 },
  { id: 'production-gce-c7', url: 'https://relay-c7.example.com', capacityRequests: 64 }
]

function cellConfig(cellId: string, role: 'cell' | 'combined' = 'cell'): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay-c3.example.com',
    cellUrl: 'https://relay-c3.example.com',
    authIssuer: 'https://auth.example.com',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.com/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role,
    cellId,
    cells: []
  } as unknown as RelayConfig
}

const config = cellConfig('production-gce-c3')

const identity = {
  sub: 'user-1',
  prof: 'profile-1',
  org: 'org-1',
  relayHostId: 'AbCdEf0123_-xyZ9'
} as unknown as RelayTokenClaims

const assignmentIdentity = { userId: identity.sub, relayHostId: identity.relayHostId }

const reservation = {
  userId: identity.sub,
  relayHostId: identity.relayHostId,
  credentialKind: 'resume',
  relayDeviceId: 'device-1',
  leaseExpiresAt: Date.now() + 60_000
}

// One database, many cells: a rollout replaces the process, a rehome moves the host to a
// different one, and both then have to answer the same phone from the same row.
async function openRelayFleet(): Promise<RelayDatabase> {
  const database = await openInMemoryRelayDatabase()
  const store = new RelayAssignmentStore(database)
  await store.reconcileCells(CELLS)
  await store.assign(assignmentIdentity)
  return database
}

// A cell process: its own store over the shared database, and only the close-reason calls and the
// admission read go to it. The control-activity bookkeeping is out of scope here and faked.
function createCell(
  database: RelayDatabase,
  cellId = 'production-gce-c3',
  role: 'cell' | 'combined' = 'cell'
) {
  const assignments = new RelayAssignmentStore(database)
  const readHostCloseReason = vi.fn(assignments.readHostCloseReason.bind(assignments))
  const facade = {
    activateControl: vi.fn().mockResolvedValue(`control:${cellId}:1`),
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    resolve: assignments.resolve.bind(assignments),
    acquireActivity: vi.fn().mockResolvedValue(undefined),
    renewControlActivity: vi.fn().mockResolvedValue(undefined),
    releaseActivity: vi.fn().mockResolvedValue(true),
    recordHostCloseReason: assignments.recordHostCloseReason.bind(assignments),
    clearHostCloseReason: assignments.clearHostCloseReason.bind(assignments),
    readHostCloseReason
  } as unknown as RelayAssignmentStore
  const credentials = {
    resolveResume: vi.fn().mockResolvedValue({ userId: identity.sub }),
    reserveCredential: vi.fn().mockResolvedValue(reservation),
    failReservation: vi.fn().mockResolvedValue(undefined)
  }
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
    cellConfig(cellId, role),
    vi.fn(),
    credentials as unknown as RelayCredentialStore,
    facade,
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
  // A reconnect the registry treats as a resume: the orphaned session is reused rather than
  // replaced, which is the branch that returns before a new session is ever built.
  const activateRebind = (socket: WebSocket): Promise<void> => {
    const sessions = (registry as unknown as { sessions: Map<string, { generation: number }> })
      .sessions
    const existing = sessions.get(`${identity.sub}\0${identity.relayHostId}`)
    if (!existing) throw new Error('no session to rebind onto')
    return (
      registry as unknown as {
        activate: (
          socket: WebSocket,
          identity: RelayTokenClaims,
          existing: unknown,
          generation: number,
          rebind: boolean,
          assignmentEpoch: number,
          appVersion: string
        ) => Promise<void>
      }
    ).activate(socket, identity, existing, existing.generation, true, 1, '1.4.173')
  }
  const sessionFor = (): unknown =>
    (registry as unknown as { sessions: Map<string, unknown> }).sessions.get(
      `${identity.sub}\0${identity.relayHostId}`
    )
  return { registry, activate, activateRebind, sessionFor, assignments, readHostCloseReason }
}

async function dialPhone(registry: HostSessionRegistry): Promise<FakeSocket> {
  const phone = new FakeSocket()
  await registry.acceptClient(phone as unknown as WebSocket, identity.relayHostId, 'credential')
  return phone
}

// The close reason is written unawaited off a socket event, so settle it the way boot would have
// by the time a phone arrives rather than asserting into a race.
async function settle(ms = CONTROL_CONTINUITY_LIMITS.orphanGraceMs + 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

// The 4404 hello body is unchanged: every shipped phone parses it with a strict
// schema, so the cause has to ride the close frame instead.
const HOST_OFFLINE_HELLO = JSON.stringify({
  type: 'relay-hello',
  ok: false,
  code: RELAY_CLOSE_CODE.HOST_OFFLINE
})

describe('host sign-out reason on phone rejection', () => {
  let database: RelayDatabase

  beforeEach(async () => {
    database = await openRelayFleet()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.clearAllTimers()
    vi.useRealTimers()
    await database.close()
  })

  it('names the sign-out to a phone that arrives after the host is gone', async () => {
    const { registry, activate, readHostCloseReason } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.send).toHaveBeenCalledWith(HOST_OFFLINE_HELLO)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
    // The cost claim, pinned: a cell answers from the row its admission check already read.
    // Asia is ~176ms from Postgres and this path is the one a phone waits on.
    expect(readHostCloseReason).not.toHaveBeenCalled()
  })

  it('looks the reason up on the one role that has no admission read to carry it', async () => {
    const { registry, activate, readHostCloseReason } = createCell(
      database,
      'production-gce-c3',
      'combined'
    )
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
    expect(readHostCloseReason).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the host died without naming a cause', async () => {
    const { registry, activate } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.terminate()
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  it('ignores a close reason the host invented, and never stores its text', async () => {
    const { registry, activate, assignments } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, 'signed-out-ish')
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
    expect(await assignments.readHostCloseReason(assignmentIdentity)).toBeNull()
    // The reason is attacker-adjacent free text: assert on the column, not only on what a
    // reader makes of it, so a future raw write cannot pass this by being filtered on read.
    const row = (
      await database.query(
        `SELECT last_host_close_reason, last_host_close_reason_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [assignmentIdentity.userId, assignmentIdentity.relayHostId]
      )
    )[0]
    expect(row?.['last_host_close_reason']).toBeNull()
    // The fence still carries the proof this host gave when it connected; it is a timestamp, and
    // the invented text reached neither column.
    expect(typeof row?.['last_host_close_reason_at']).toBe('number')
  })

  it('forgets the sign-out once the host proves itself again', async () => {
    const { registry, activate, assignments } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    const reconnected = new FakeSocket()
    await activate(reconnected as unknown as WebSocket, 2)
    await settle(0)
    expect(await assignments.readHostCloseReason(assignmentIdentity)).toBeNull()
    // Drop it abruptly, as a network death would, so only a stale reason could still name a cause.
    reconnected.terminate()
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  // A live host is present: the 4404 there is an attach deadline, not absence.
  it('never names a cause while the host control is connected', async () => {
    const { registry, activate } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    const phone = await dialPhone(registry)
    expect(phone.close).not.toHaveBeenCalled()
    expect(control.send).toHaveBeenCalledWith(expect.stringContaining('"type":"conn-open"'))
  })

  it('still names the sign-out to a phone that arrives after the cell was replaced', async () => {
    const first = createCell(database)
    const control = new FakeSocket()
    await first.activate(control as unknown as WebSocket, 1)
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    // The rollout: a new process, with none of the predecessor's memory, on the same cell.
    const restarted = createCell(database)
    const phone = await dialPhone(restarted.registry)

    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
  })

  it('names the sign-out from the cell the host was rehomed to', async () => {
    const source = createCell(database)
    const control = new FakeSocket()
    await source.activate(control as unknown as WebSocket, 1)
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    // The rehome, reduced to what it does to this row: the reason is a column on it, so the
    // cell the host lands on reads the same value the cell that saw the close wrote.
    await database.query(
      `UPDATE relay_assignments SET cell_id = ? WHERE user_id = ? AND relay_host_id = ?`,
      ['production-gce-c7', assignmentIdentity.userId, assignmentIdentity.relayHostId]
    )
    const target = createCell(database, 'production-gce-c7')
    const phone = await dialPhone(target.registry)

    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
  })

  it('clears the sign-out when the host rebinds onto its orphaned session', async () => {
    const { registry, activate, activateRebind, sessionFor, assignments } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)
    const orphaned = sessionFor()
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    // Inside the orphan grace, so the session is orphaned rather than gone and the reconnect
    // resumes it. The branch that does so returns before the new-session path the clear used
    // to sit on.
    await settle(1)
    expect(await assignments.readHostCloseReason(assignmentIdentity)).toBe(
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )

    const rebound = new FakeSocket()
    await activateRebind(rebound as unknown as WebSocket)
    await settle(0)
    // Not vacuous: a replaced session would make this a different object and prove nothing.
    expect(sessionFor()).toBe(orphaned)
    expect(await assignments.readHostCloseReason(assignmentIdentity)).toBeNull()

    // Drop it the way a network death would, so only a stale reason could still name a cause.
    rebound.terminate()
    await settle()
    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  // Both writes are unawaited, so either order can reach the row. These pin the rule that decides
  // the outcome on timestamps alone, which is why they need no concurrency to be meaningful.
  describe('when a close and a proof race to the row', () => {
    // Order-neutral on purpose: each test says which event gets which instant.
    const EARLIER = 1_000
    const LATER = 2_000

    it('drops a close still being written when the host has since proved itself', async () => {
      const store = new RelayAssignmentStore(database)
      await store.clearHostCloseReason(assignmentIdentity, LATER)
      await store.recordHostCloseReason(
        assignmentIdentity,
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT,
        EARLIER
      )

      expect(await store.readHostCloseReason(assignmentIdentity)).toBeNull()
    })

    it('clears a reason the host recorded before it proved itself', async () => {
      const store = new RelayAssignmentStore(database)
      await store.recordHostCloseReason(
        assignmentIdentity,
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT,
        EARLIER
      )
      await store.clearHostCloseReason(assignmentIdentity, LATER)

      expect(await store.readHostCloseReason(assignmentIdentity)).toBeNull()
    })

    // The rule has to keep real sign-outs, or it would trade one wrong verdict for another.
    it('keeps a close that lands at the same instant as the proof, in either order', async () => {
      const store = new RelayAssignmentStore(database)
      await store.clearHostCloseReason(assignmentIdentity, LATER)
      await store.recordHostCloseReason(
        assignmentIdentity,
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT,
        LATER
      )
      expect(await store.readHostCloseReason(assignmentIdentity)).toBe(
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT
      )

      await store.clearHostCloseReason(assignmentIdentity, LATER)
      expect(await store.readHostCloseReason(assignmentIdentity)).toBe(
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT
      )
    })

    it('keeps a close that happened after the proof', async () => {
      const store = new RelayAssignmentStore(database)
      await store.clearHostCloseReason(assignmentIdentity, EARLIER)
      await store.recordHostCloseReason(
        assignmentIdentity,
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT,
        LATER
      )

      expect(await store.readHostCloseReason(assignmentIdentity)).toBe(
        RELAY_HOST_CLOSE_REASON.SIGNED_OUT
      )
    })
  })

  // What makes the column addition deferrable: a boot that could not take the lock still serves,
  // with the verdict it gave before these columns existed.
  it('serves phones normally on a boot that has not applied the columns', async () => {
    await database.query(`ALTER TABLE relay_assignments DROP COLUMN last_host_close_reason`)
    await database.query(`ALTER TABLE relay_assignments DROP COLUMN last_host_close_reason_at`)
    const { registry, activate } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)

    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    const phone = await dialPhone(registry)
    expect(phone.send).toHaveBeenCalledWith(HOST_OFFLINE_HELLO)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      'relay connection rejected'
    )
  })

  it('outlives the dormant assignment TTL the per-cell memory expired at', async () => {
    const { registry, activate, assignments } = createCell(database)
    const control = new FakeSocket()
    await activate(control as unknown as WebSocket, 1)
    control.close(1000, RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    await settle()

    // Day two, with the desktop still signed out and nothing having re-proved it.
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    expect(await assignments.readHostCloseReason(assignmentIdentity)).toBe(
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )

    const phone = await dialPhone(registry)
    expect(phone.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.HOST_OFFLINE,
      RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    )
  })
})
