import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterEach, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase, type SqlRow } from './database.js'

let database: RelayDatabase | undefined
afterEach(async () => await database?.close())

it.each([false, true])(
  'looks up a whole drain inventory with linear identity reads (expired: %s)',
  async (expired) => {
    database = await openInMemoryRelayDatabase()
    let measuring = false
    let identityReads = 0
    let indexedRows = 0
    const instrument = (delegate: RelayDatabase): RelayDatabase => ({
      query: (sql, params) => delegate.query(sql, params),
      queryLocked: async (sql, params, options) => {
        const rows = await delegate.queryLocked(sql, params, options)
        if (
          !measuring ||
          !sql.includes('WHERE EXISTS') ||
          !(sql.includes('SELECT assignment.*') || sql.includes('SELECT lease.*'))
        ) {
          return rows
        }
        indexedRows += rows.length
        return rows.map(
          (row): SqlRow =>
            new Proxy(row, {
              get(target, key) {
                if (key === 'user_id' || key === 'relay_host_id') {
                  identityReads++
                }
                return Reflect.get(target, key)
              }
            })
        )
      },
      transaction: (operation, options) =>
        delegate.transaction((tx) => operation(instrument(tx)), options),
      close: () => delegate.close()
    })
    let now = 100
    const store = new RelayAssignmentStore(instrument(database), () => now, {
      requireLiveCells: true
    })
    const cells = ['a', 'b'].map((id) => ({
      id: `cell-${id}`,
      url: `https://relay-${id}.example.com`,
      capacityRequests: 500
    }))
    await store.reconcileCells(cells)
    const incarnation = '11111111-1111-4111-8111-111111111111'
    for (const cell of cells) {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: incarnation,
        startedAt: 50,
        ready: true,
        observedRequests: 0
      })
    }
    await store.setCellEnabled('cell-b', false)
    const identities = Array.from({ length: 50 }, (_, index) => ({
      userId: `user-${index % 5}`,
      relayHostId: `host${String(index).padStart(12, '0')}`
    }))
    for (const identity of identities) {
      await store.assign(identity)
    }
    await store.setCellEnabled('cell-b', true)
    await store.setCellEnabled('cell-a', false)
    for (const identity of identities) {
      const migration = await store.startEvacuation(identity, 'cell-b')
      await store.markMigrationTargetRegistered(identity, {
        cellId: 'cell-b',
        assignmentEpoch: migration.assignmentEpoch
      })
    }
    const attempt = {
      attemptId: '55555555-5555-4555-8555-555555555555',
      cellId: 'cell-a',
      cellIncarnation: incarnation,
      traceValue: '66666666-6666-4666-8666-666666666666',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)
    if (expired) {
      now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
      await store.releaseExpiredActivityLeases()
      for (const cell of cells) {
        await store.recordCellHeartbeat({
          cellId: cell.id,
          cellUrl: cell.url,
          cellIncarnation: incarnation,
          startedAt: 50,
          ready: true,
          observedRequests: 0
        })
      }
    }
    measuring = true
    await expect(store.beginCellDrainSend(attempt)).resolves.toMatchObject({
      state: 'send-may-have-started',
      shouldSend: true
    })
    expect(indexedRows).toBeGreaterThanOrEqual(100)
    expect(identityReads).toBeLessThanOrEqual(indexedRows * 2)
    const migrations = await database.query(
      'SELECT expires_at FROM relay_assignment_migrations'
    )
    expect(migrations).toHaveLength(50)
    expect(
      migrations.every(
        (row) => row.expires_at === now + ASSIGNMENT_LIMITS.migrationLeaseMs
      )
    ).toBe(true)
  }
)
