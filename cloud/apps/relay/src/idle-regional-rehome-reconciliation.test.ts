import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayDatabase } from './database.js'
import { openIdleRehomeTestDatabase } from './idle-regional-rehome-test-database.js'

const request = {
  v: 1 as const,
  attemptId: '33333333-3333-4333-8333-333333333333',
  userId: 'idle-reconciliation-test',
  relayHostId: 'abcdefghijklmnop',
  sourceCellId: 'source',
  sourceCellIncarnation: '11111111-1111-4111-8111-111111111111',
  sourceAssignmentEpoch: 1,
  sourceGeneration: 7,
  targetCellId: 'target'
}
const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.close()
})

async function setup() {
  const database = await openIdleRehomeTestDatabase()
  databases.push(database)
  const store = new RelayAssignmentStore(database, () => 100_000_000)
  await store.reconcileCells([
    { id: 'source', url: 'https://source.example.test', capacityRequests: 100 },
    { id: 'target', url: 'https://target.example.test', capacityRequests: 100 }
  ])
  await store.assign(request)
  await store.activateControl(request, {
    cellId: request.sourceCellId,
    assignmentEpoch: request.sourceAssignmentEpoch,
    generation: request.sourceGeneration,
    cellIncarnation: request.sourceCellIncarnation
  })
  return { database, store }
}

describe('idle cutover durable reconciliation', () => {
  it('only permits reopening when the exact source still owns the assignment', async () => {
    const { store } = await setup()
    expect(await store.reconcileIdleRegionalRehome(request)).toBe('not-committed')
    await store.activateControl(request, {
      cellId: request.sourceCellId,
      assignmentEpoch: request.sourceAssignmentEpoch,
      generation: request.sourceGeneration + 1,
      cellIncarnation: request.sourceCellIncarnation
    })
    expect(await store.reconcileIdleRegionalRehome(request)).toBe('stale')
  })

  it('does not reopen an obsolete source after an assignment change', async () => {
    const { store } = await setup()
    await store.startEvacuation(request, request.targetCellId)
    expect(await store.reconcileIdleRegionalRehome(request)).toBe('stale')
  })

  it('propagates unavailable durable state instead of declaring rollback', async () => {
    const { database, store } = await setup()
    vi.spyOn(database, 'transaction').mockRejectedValue(new Error('database_unavailable'))
    await expect(store.reconcileIdleRegionalRehome(request)).rejects.toThrow('database_unavailable')
  })

  it('waits for an outstanding assignment transaction before deciding authority', async () => {
    const { database, store } = await setup()
    let release!: () => void
    let entered!: () => void
    const locked = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const commit = database.transaction(async (transaction) => {
      await transaction.queryLocked(
        'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?',
        [request.userId, request.relayHostId]
      )
      entered()
      await gate
      await transaction.query(
        'UPDATE relay_assignments SET assignment_epoch = assignment_epoch + 1 WHERE user_id = ? AND relay_host_id = ?',
        [request.userId, request.relayHostId]
      )
    })
    await locked
    let settled = false
    const reconciliation = store.reconcileIdleRegionalRehome(request).finally(() => {
      settled = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally {
      release()
      await commit
      await reconciliation
    }
    expect(await reconciliation).toBe('stale')
  })
})
