import { EventEmitter } from 'node:events'
import { ASSIGNMENT_LIMITS, RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { HostSessionRegistry, type HostSession } from './host-session-registry.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const sourceCell = {
  id: 'control-recovery-source',
  url: 'https://control-recovery-source.example.com',
  capacityRequests: 100
}
const targetCell = {
  id: 'control-recovery-target',
  url: 'https://control-recovery-target.example.com',
  capacityRequests: 100
}
const userId = 'control-recovery-user'
const identities = ['controlrecovery1', 'controlrecovery2'].map((relayHostId) => ({
  userId,
  relayHostId
}))

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })
}

const observer = {
  recordAuth: vi.fn(),
  recordForwardedBytes: vi.fn(),
  recordHttp: vi.fn(),
  recordReconnect: vi.fn(),
  recordSql: vi.fn()
} satisfies RelayRuntimeObserver

type RegistryInternals = {
  activate(
    socket: WebSocket,
    identity: RelayTokenClaims,
    existing: HostSession | null,
    generation: number,
    rebind: boolean,
    assignmentEpoch: number,
    appVersion: string
  ): Promise<void>
  heartbeat(session: HostSession): void
}

describePostgres('expired control lease after a database outage', () => {
  let database: RelayDatabase
  let now = 1_900_000_000_000

  const removeFixtureRows = async (): Promise<void> => {
    await database.query(`DELETE FROM relay_control_connection_reservations WHERE user_id = ?`, [
      userId
    ])
    await database.query(`DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`, [userId])
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [userId])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [userId])
    for (const cell of [sourceCell, targetCell]) {
      await database.query(`DELETE FROM relay_cell_connection_snapshots WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cell_connection_limits WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [cell.id])
    }
  }

  const createRegistry = (store: RelayAssignmentStore): HostSessionRegistry =>
    new HostSessionRegistry(
      {
        role: 'cell',
        cellId: sourceCell.id
      } as RelayConfig,
      vi.fn(),
      {} as RelayCredentialStore,
      store,
      new ProcessQueuedByteBudget(),
      observer,
      () => now
    )

  const activate = async (
    registry: HostSessionRegistry,
    store: RelayAssignmentStore,
    index: number
  ): Promise<{ activityId: string; session: HostSession; socket: FakeSocket }> => {
    const identity = identities[index]!
    const assignment = await store.assign(identity)
    const socket = new FakeSocket()
    const token = {
      sub: identity.userId,
      prof: 'control-recovery-profile',
      relayHostId: identity.relayHostId,
      purpose: 'host-control',
      exp: 4_102_444_800
    } satisfies RelayTokenClaims
    await (registry as unknown as RegistryInternals).activate(
      socket as unknown as WebSocket,
      token,
      null,
      1,
      false,
      assignment.assignmentEpoch,
      'control-recovery-test'
    )
    const session = registry.get(identity)!
    clearInterval(session.heartbeatTimer!)
    session.heartbeatTimer = null
    return { activityId: session.controlActivityId!, session, socket }
  }

  const heartbeat = (registry: HostSessionRegistry, session: HostSession): void => {
    session.activityRenewalDueAt = now
    session.lastPongAt = now
    const internals = registry as unknown as RegistryInternals
    internals.heartbeat(session)
  }

  const leaseRows = async (relayHostId: string) =>
    await database.query(
      `SELECT activity_id, cell_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?`,
      [userId, relayHostId]
    )

  const waitForRenewal = async (
    socket: FakeSocket,
    relayHostId: string,
    expectedRows: number
  ): Promise<void> => {
    await expect
      .poll(
        async () =>
          socket.close.mock.calls.length > 0 ||
          (await leaseRows(relayHostId)).length === expectedRows
      )
      .toBe(true)
  }

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
  })

  beforeEach(async () => {
    now = 1_900_000_000_000
    await removeFixtureRows()
  })

  afterEach(async () => {
    await removeFixtureRows()
  })

  afterAll(async () => {
    if (database) await database.close()
  })

  it('re-acquires a reaped lease while the assignment remains on this cell', async () => {
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([sourceCell])
    const registry = createRegistry(store)
    const { activityId, session, socket } = await activate(registry, store, 0)

    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    expect(await leaseRows(identities[0]!.relayHostId)).toHaveLength(0)

    heartbeat(registry, session)
    await waitForRenewal(socket, identities[0]!.relayHostId, 1)

    expect(socket.close).not.toHaveBeenCalled()
    expect(await leaseRows(identities[0]!.relayHostId)).toEqual([
      expect.objectContaining({ activity_id: activityId, cell_id: sourceCell.id })
    ])
    registry.drain(0)
  })

  it('closes without stealing back a lease that moved to another cell', async () => {
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([sourceCell, targetCell])
    const registry = createRegistry(store)
    const { activityId, session, socket } = await activate(registry, store, 1)
    const identity = identities[1]!
    await database.query(
      `UPDATE relay_assignment_activity_leases SET cell_id = ?
       WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
      [targetCell.id, identity.userId, identity.relayHostId, activityId]
    )

    await expect(
      store.renewControlActivity(identity, {
        activityId,
        cellId: sourceCell.id,
        expiresAt: now + ASSIGNMENT_LIMITS.activityLeaseMs
      })
    ).rejects.toThrow('control_activity_moved')

    heartbeat(registry, session)
    await expect.poll(() => socket.close.mock.calls.length).toBe(1)

    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'control activity moved')
    expect(await leaseRows(identity.relayHostId)).toEqual([
      expect.objectContaining({ activity_id: activityId, cell_id: targetCell.id })
    ])
    registry.drain(0)
  })
})
