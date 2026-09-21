import { ASSIGNMENT_LIMITS, RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  openRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type SqlRow
} from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const sourceCell = {
  id: 'control-renewal-source',
  url: 'https://control-renewal-source.example.com',
  capacityRequests: 100
}
const targetCell = {
  id: 'control-renewal-target',
  url: 'https://control-renewal-target.example.com',
  capacityRequests: 100
}
const userId = 'control-renewal-postgres-user'
const identities = Array.from({ length: 6 }, (_, index) => ({
  userId,
  relayHostId: `controlrenewal${index + 1}`
}))

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

class StallFirstTransactionDatabase implements RelayDatabase {
  readonly stalled = signal()
  readonly continue = signal()
  private stallNext = true

  constructor(private readonly database: RelayDatabase) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.database.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.database.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    if (this.stallNext) {
      this.stallNext = false
      this.stalled.resolve()
      await this.continue.promise
    }
    return await this.database.transaction(operation)
  }

  async close(): Promise<void> {}
}

class StallFirstRenewalQueryDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const
  readonly stalled = signal()
  readonly continue = signal()
  private stallNext = true

  constructor(private readonly database: RelayDatabase) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    if (this.stallNext && sql.includes('WITH assignment_state AS MATERIALIZED')) {
      this.stallNext = false
      this.stalled.resolve()
      await this.continue.promise
    }
    return await this.database.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.database.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await this.database.transaction(operation)
  }

  async close(): Promise<void> {}
}

class RenewalQueryProbeDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const
  renewalQueries = 0
  transactions = 0

  constructor(private readonly database: RelayDatabase) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    if (sql.includes('WITH assignment_state AS MATERIALIZED')) this.renewalQueries++
    return await this.database.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.database.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    this.transactions++
    return await this.database.transaction(operation)
  }

  async close(): Promise<void> {}
}

describePostgres('PostgreSQL control renewal', () => {
  let database: RelayDatabase
  let now = 1_900_000_000_000
  const controlId = (cellId: string): string => `control:${cellId}:1`

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

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    await removeFixtureRows()
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([sourceCell])
    for (const identity of identities) {
      const assignment = await store.assign(identity)
      expect(assignment.cellId).toBe(sourceCell.id)
      await store.activateControl(identity, {
        cellId: sourceCell.id,
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 1
      })
    }
    await store.reconcileCells([sourceCell, targetCell])
  })

  afterAll(async () => {
    if (!database) return
    await removeFixtureRows()
    await database.close()
  })

  it('reaches PostgreSQL past an acquireActivity stalled in the identity queue', async () => {
    const probe = new StallFirstTransactionDatabase(database)
    const store = new RelayAssignmentStore(probe, () => now)
    const identity = identities[0]!
    const queued = store.acquireActivity(identity, {
      activityId: 'splice:queue-blocker',
      kind: 'splice',
      cellId: sourceCell.id
    })
    await probe.stalled.promise
    const expiresAt = now + 105_000

    try {
      await Promise.race([
        store.renewControlActivity(identity, {
          activityId: controlId(sourceCell.id),
          cellId: sourceCell.id,
          expiresAt
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('renewal_waited_for_identity_queue')), 2_000)
        )
      ])
      const row = (
        await database.query(
          `SELECT expires_at FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
          [identity.userId, identity.relayHostId, controlId(sourceCell.id)]
        )
      )[0]
      expect(Number(row!.expires_at)).toBe(expiresAt)
    } finally {
      probe.continue.resolve()
      await queued
    }
  })

  it('does not let a late older renewal rewind lease or activity timestamps', async () => {
    const probe = new StallFirstRenewalQueryDatabase(database)
    const store = new RelayAssignmentStore(probe, () => now)
    const identity = identities[1]!
    const earlierNow = now
    const earlierExpiry = earlierNow + 105_000
    const earlier = store.renewControlActivity(identity, {
      activityId: controlId(sourceCell.id),
      cellId: sourceCell.id,
      expiresAt: earlierExpiry
    })
    await probe.stalled.promise

    now += 30_000
    const laterNow = now
    const laterExpiry = laterNow + 105_000
    await store.renewControlActivity(identity, {
      activityId: controlId(sourceCell.id),
      cellId: sourceCell.id,
      expiresAt: laterExpiry
    })
    probe.continue.resolve()
    await earlier

    const lease = (
      await database.query(
        `SELECT expires_at, updated_at FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, controlId(sourceCell.id)]
      )
    )[0]
    const assignment = (
      await database.query(
        `SELECT lease_expires_at, last_activity_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    expect(lease).toMatchObject({
      expires_at: String(laterExpiry),
      updated_at: String(laterNow)
    })
    expect(assignment).toMatchObject({
      lease_expires_at: String(laterExpiry),
      last_activity_at: String(laterNow)
    })
  })

  it('allows the source only while its exact forward migration remains active', async () => {
    const identity = identities[2]!
    const store = new RelayAssignmentStore(database, () => now)
    const migration = await store.startEvacuation(identity, targetCell.id)
    const activeExpiry = now + 105_000

    await expect(
      store.renewControlActivity(identity, {
        activityId: controlId(sourceCell.id),
        cellId: sourceCell.id,
        expiresAt: activeExpiry
      })
    ).resolves.toBeUndefined()

    await database.query(
      `UPDATE relay_assignment_migrations SET completed_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
      [now, identity.userId, identity.relayHostId, migration.assignmentEpoch]
    )
    now += 30_000
    await expect(
      store.renewControlActivity(identity, {
        activityId: controlId(sourceCell.id),
        cellId: sourceCell.id,
        expiresAt: now + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')

    const lease = (
      await database.query(
        `SELECT expires_at FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, controlId(sourceCell.id)]
      )
    )[0]
    expect(Number(lease!.expires_at)).toBe(activeExpiry)
  })

  it('does not resurrect a control released while its renewal was stalled', async () => {
    const probe = new StallFirstRenewalQueryDatabase(database)
    const renewalStore = new RelayAssignmentStore(probe, () => now)
    const releaseStore = new RelayAssignmentStore(database, () => now)
    const identity = identities[3]!
    const renewal = renewalStore.renewControlActivity(identity, {
      activityId: controlId(sourceCell.id),
      cellId: sourceCell.id,
      expiresAt: now + 105_000
    })
    await probe.stalled.promise

    await expect(releaseStore.releaseActivity(identity, controlId(sourceCell.id))).resolves.toBe(
      true
    )
    probe.continue.resolve()
    await expect(renewal).rejects.toThrow('control_activity_not_found')
    const rows = await database.query(
      `SELECT activity_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
      [identity.userId, identity.relayHostId, controlId(sourceCell.id)]
    )
    expect(rows).toHaveLength(0)
  })

  it('rejects a renewal expiry beyond the maximum control lease horizon', async () => {
    const identity = identities[4]!
    const store = new RelayAssignmentStore(database, () => now)
    const maximumExpiry =
      now +
      ASSIGNMENT_LIMITS.activityLeaseMs +
      RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2

    await expect(
      store.renewControlActivity(identity, {
        activityId: controlId(sourceCell.id),
        cellId: sourceCell.id,
        expiresAt: maximumExpiry + 1
      })
    ).rejects.toThrow('invalid_activity_expiry')
  })

  it('uses one autocommitted PostgreSQL statement for a steady renewal', async () => {
    const probe = new RenewalQueryProbeDatabase(database)
    const store = new RelayAssignmentStore(probe, () => now)
    const identity = identities[5]!

    await store.renewControlActivity(identity, {
      activityId: controlId(sourceCell.id),
      cellId: sourceCell.id,
      expiresAt: now + 105_000
    })

    expect(probe.renewalQueries).toBe(1)
    expect(probe.transactions).toBe(0)
  })
})
