import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from '../assignment-store.js'
import type { RelayDatabase, RelayLockOptions } from '../../database/database.js'
import { openIdleRehomeTestDatabase } from './idle-regional-rehome-test-database.js'

const identity = { userId: 'idle-store-test', relayHostId: 'abcdefghijklmnop' }
const incarnations = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
]
const cells = [
  {
    id: 'source',
    url: 'https://source.example.test',
    region: 'us-central1' as const,
    capacityRequests: 100
  },
  {
    id: 'target',
    url: 'https://target.example.test',
    region: 'asia-east2' as const,
    capacityRequests: 100
  }
]
const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.close()
})

async function setup() {
  const database = await openIdleRehomeTestDatabase()
  databases.push(database)
  let now = 100_000_000
  const store = new RelayAssignmentStore(database, () => now, { regionalRehomeCohortPercent: 100 })
  await store.inspectRegionalRehomeControl()
  now += 86_400_000
  await store.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: now,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    hostCooldownMs: 604_800_000,
    drainGraceMs: 60_000
  })
  await store.reconcileCells(cells)
  const safety = {
    observedAt: now,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
  for (const [index, cell] of cells.entries()) {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region,
      cellIncarnation: incarnations[index]!,
      startedAt: now - 1_000,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellRegionalRehomeStatus({
      cellId: cell.id,
      cellIncarnation: incarnations[index]!,
      regionalRehomeProtocol: 3,
      safety
    })
  }
  const assignment = await store.assign(identity, undefined, 'us-central1')
  await store.activateControl(identity, {
    cellId: cells[0]!.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 7,
    cellIncarnation: incarnations[0],
    idleRegionalRehome: true
  })
  const issued = await store.exchangeRegionCorrection(
    identity,
    { v: 1, action: 'issue-window' },
    assignment.assignmentEpoch
  )
  await store.exchangeRegionCorrection(
    identity,
    {
      v: 1,
      action: 'report',
      generation: issued.window!.generation,
      assignmentEpoch: assignment.assignmentEpoch,
      policyVersion: 1,
      outcome: 'conclusive',
      measurements: { 'us-central1': 180, 'asia-east2': 40 }
    },
    assignment.assignmentEpoch
  )
  const request = {
    v: 1 as const,
    ...identity,
    attemptId: '33333333-3333-4333-8333-333333333333',
    sourceCellId: cells[0]!.id,
    sourceCellIncarnation: incarnations[0]!,
    sourceAssignmentEpoch: assignment.assignmentEpoch,
    sourceGeneration: 7,
    targetCellId: cells[1]!.id
  }
  return { store, database, safety, request }
}

describe('constrained idle regional assignment transaction', () => {
  it('sees durable control changes between candidate polls', async () => {
    const { store, database, safety } = await setup()
    await database.query("UPDATE relay_region_rehome_control SET enabled = 0 WHERE control_id = 'global'")
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
    await database.query("UPDATE relay_region_rehome_control SET enabled = 1 WHERE control_id = 'global'")
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toHaveLength(1)
    await database.query("UPDATE relay_region_rehome_control SET enabled = 0 WHERE control_id = 'global'")
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
  })

  it.each([10, 11])('reserves source activity plus assignment at target capacity %i', async (capacity) => {
    const { store, database, safety, request } = await setup()
    // Model three source activity units and seven units already reserved at the target.
    await database.query(
      'UPDATE relay_assignment_activity_leases SET request_units = 3 WHERE user_id = ? AND relay_host_id = ?',
      [identity.userId, identity.relayHostId]
    )
    await database.query("UPDATE relay_cells SET reserved_requests = 4 WHERE cell_id = 'source'")
    await database.query(
      "UPDATE relay_cells SET reserved_requests = 7, capacity_requests = ? WHERE cell_id = 'target'",
      [capacity]
    )
    const candidates = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(candidates).toHaveLength(capacity === 11 ? 1 : 0)
    expect(await store.commitIdleRegionalRehome(request, safety)).toEqual(
      capacity === 11
        ? { outcome: 'committed' }
        : { outcome: 'deferred', reason: 'candidate-ineligible' }
    )
    const [target] = await database.query("SELECT reserved_requests FROM relay_cells WHERE cell_id = 'target'")
    expect(Number(target!.reserved_requests)).toBe(capacity === 11 ? 11 : 7)
    expect(await store.resolve(identity)).toMatchObject({
      cellId: capacity === 11 ? 'target' : 'source',
      assignmentEpoch: capacity === 11 ? 2 : 1
    })
  })

  // sourceRequestUnits reads a reserve cell's missing phone leases as zero units; selection must drop it.
  it.each(['source', 'target'])('drops every candidate while the %s cell is recorded as reserve', async (cellId) => {
    const { store, safety } = await setup()
    await store.setCellAdmitMode(cellId, 'reserve')
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
    await store.setCellAdmitMode(cellId, 'db')
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toHaveLength(1)
  })

  it('leaves the candidate page cursor untouched across a closed dispatch budget', async () => {
    const { store, database, safety } = await setup()
    for (const table of [
      'relay_assignments',
      'relay_assignment_activity_leases',
      'relay_control_capabilities',
      'relay_region_decisions'
    ]) {
      const template = (
        await database.query(`SELECT * FROM ${table} WHERE user_id = ? AND relay_host_id = ?`, [
          identity.userId,
          identity.relayHostId
        ])
      )[0]!
      const columns = Object.keys(template)
      for (let index = 0; index < 100; index++) {
        const values = columns.map((column) =>
          column === 'user_id' || column === 'relay_host_id' ? '?' : column
        )
        await database.query(
          `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values.join(', ')} FROM ${table}
           WHERE user_id = ? AND relay_host_id = ?`,
          [
            `idle-store-test-${String(index).padStart(3, '0')}`,
            `pagehost${String(index).padStart(8, '0')}`,
            identity.userId,
            identity.relayHostId
          ]
        )
      }
    }
    const first = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(first).toHaveLength(100)
    await database.query(
      `UPDATE relay_region_rehome_worker_state SET next_dispatch_at = ? WHERE worker_id = 'global'`,
      [safety.observedAt + 1]
    )
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
    await database.query(
      `UPDATE relay_region_rehome_worker_state SET next_dispatch_at = 0 WHERE worker_id = 'global'`
    )
    const next = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(next).toHaveLength(1)
    expect(next[0]!.relayHostId).toBe('pagehost00000099')
    expect(first.some((c) => c.relayHostId === next[0]!.relayHostId)).toBe(false)
  })

  it.runIf(Boolean(process.env.ORCA_IDLE_REHOME_POSTGRES_URL))(
    'rechecks generation when replacement wins after the initial authority lookup',
    async () => {
      const { store, safety, request, database } = await setup()
      const held = holdStatement(database, 'SELECT * FROM relay_region_rehome_control')
      const commit = store.commitIdleRegionalRehome(request, safety)
      try {
        await held.entered
        await store.activateControl(identity, {
          cellId: 'source',
          assignmentEpoch: 1,
          generation: 8,
          cellIncarnation: incarnations[0],
          idleRegionalRehome: true
        })
      } finally {
        held.release()
        await commit
      }
      expect(await commit).toEqual({ outcome: 'deferred', reason: 'candidate-ineligible' })
      expect(await store.reconcileIdleRegionalRehome(request)).toBe('stale')
      expect(await database.query('SELECT * FROM relay_region_rehome_attempts')).toEqual([])
    }
  )

  it('rejects source replacement when the cutover already holds assignment authority', async () => {
    const { store, safety, request, database } = await setup()
    const held = holdStatement(database, 'UPDATE relay_assignments SET cell_id')
    const commit = store.commitIdleRegionalRehome(request, safety)
    await held.entered
    const replacement = store.activateControl(identity, {
      cellId: 'source',
      assignmentEpoch: 1,
      generation: 8,
      cellIncarnation: incarnations[0],
      idleRegionalRehome: true
    })
    const rejected = expect(replacement).rejects.toThrow('wrong_assignment')
    try {
      held.release()
      expect(await commit).toEqual({ outcome: 'committed' })
      await rejected
      expect(await store.resolve(identity)).toMatchObject({ cellId: 'target', assignmentEpoch: 2 })
    } finally {
      held.release()
      try {
        await commit
      } finally {
        await rejected
      }
    }
  })

  it('finds the committed attempt after its database reply is lost', async () => {
    const { store, safety, request, database } = await setup()
    const transaction = database.transaction.bind(database)
    const intercepted = vi
      .spyOn(database, 'transaction')
      .mockImplementation(async (operation, options) => {
        let changed = false
        const result = await transaction(
          async (tx) =>
            operation(
              new Proxy(tx, {
                get(target, key) {
                  if (key === 'query')
                    return async (sql: string, params?: unknown[]) => {
                      if (sql.includes('INSERT INTO relay_region_rehome_attempts')) changed = true
                      return target.query(sql, params)
                    }
                  const value = Reflect.get(target, key)
                  return typeof value === 'function' ? value.bind(target) : value
                }
              })
            ),
          options
        )
        if (changed) throw new Error('simulated_commit_reply_lost')
        return result
      })
    await expect(store.commitIdleRegionalRehome(request, safety)).rejects.toThrow(
      'simulated_commit_reply_lost'
    )
    intercepted.mockRestore()
    expect(await store.reconcileIdleRegionalRehome(request)).toBe('committed')
    expect(await store.commitIdleRegionalRehome(request, safety)).toEqual({ outcome: 'committed' })
    expect(await database.query('SELECT * FROM relay_region_rehome_attempts')).toHaveLength(1)
  })

  it('rejects a replaced control and never substitutes a different target', async () => {
    const { store, safety, request } = await setup()
    expect(
      await store.commitIdleRegionalRehome({ ...request, targetCellId: 'missing' }, safety)
    ).toEqual({ outcome: 'deferred', reason: 'candidate-ineligible' })
    await store.activateControl(identity, {
      cellId: 'source',
      assignmentEpoch: 1,
      generation: 8,
      cellIncarnation: incarnations[0],
      idleRegionalRehome: true
    })
    expect(await store.commitIdleRegionalRehome(request, safety)).toEqual({ outcome: 'stale' })
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'source', assignmentEpoch: 1 })
  })

  it('does not commit without process safety or cohort authorization', async () => {
    const { store, safety, request, database } = await setup()
    expect(await store.commitIdleRegionalRehome(request)).toEqual({
      outcome: 'deferred',
      reason: 'director-safety-stale'
    })
    expect(await store.commitIdleRegionalRehome(request, safety, 0)).toEqual({
      outcome: 'deferred',
      reason: 'cohort-closed'
    })
    expect(await database.query('SELECT * FROM relay_region_rehome_attempts')).toEqual([])
  })

})

function holdStatement(database: RelayDatabase, fragment: string) {
  let entered!: () => void
  let release!: () => void
  const arrival = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  const transaction = database.transaction.bind(database)
  vi.spyOn(database, 'transaction').mockImplementation((operation, options) =>
    transaction(async (tx) => {
      return operation(
        new Proxy(tx, {
          get(target, key) {
            if (key === 'query' || key === 'queryLocked')
              return async (sql: string, params?: unknown[], lockOptions?: RelayLockOptions) => {
                if (!held && sql.includes(fragment)) {
                  held = true
                  entered()
                  await gate
                }
                return key === 'queryLocked'
                  ? target.queryLocked(sql, params, lockOptions)
                  : target.query(sql, params)
              }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      )
    }, options)
  )
  return { entered: arrival, release }
}
