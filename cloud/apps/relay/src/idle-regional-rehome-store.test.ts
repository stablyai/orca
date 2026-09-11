import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayDatabase, RelayLockOptions } from './database.js'
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
  it('progresses past a full page of busy candidates without writing eligibility state', async () => {
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
    const next = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(first).toHaveLength(100)
    expect(next).toHaveLength(1)
    expect(next[0]!.relayHostId).toBe('pagehost00000099')
    const restarted = new RelayAssignmentStore(database, () => safety.observedAt, {
      regionalRehomeCohortPercent: 100
    })
    expect(await restarted.selectIdleRegionalRehomeCandidates(safety)).toEqual(first)
    expect(await database.query('SELECT * FROM relay_region_rehome_attempts')).toEqual([])
    const decisions = await database.query('SELECT last_considered_at FROM relay_region_decisions')
    expect(decisions.every((decision) => Number(decision.last_considered_at) === 0)).toBe(true)
  })

  it.runIf(Boolean(process.env.ORCA_IDLE_REHOME_POSTGRES_URL))(
    'rechecks generation when replacement wins after the initial authority lookup',
    async () => {
      const { store, safety, request, database } = await setup()
      const held = holdStatement(database, 'SELECT * FROM relay_region_rehome_control')
      const commit = store.commitIdleRegionalRehome(request, safety)
      await held.entered
      try {
        await store.activateControl(identity, {
          cellId: 'source',
          assignmentEpoch: 1,
          generation: 8,
          cellIncarnation: incarnations[0],
          idleRegionalRehome: true
        })
      } finally {
        held.release()
      }
      expect(await commit).toEqual({ outcome: 'deferred' })
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
    held.release()
    expect(await commit).toEqual({ outcome: 'committed' })
    await rejected
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'target', assignmentEpoch: 2 })
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

  it('commits the requested move once and records its outcome without source retention', async () => {
    const { store, database, safety, request } = await setup()
    expect(await store.commitIdleRegionalRehome(request, safety)).toEqual({ outcome: 'committed' })
    expect(await store.commitIdleRegionalRehome(request, safety)).toEqual({ outcome: 'committed' })
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'target', assignmentEpoch: 2 })
    const attempts = await database.query('SELECT * FROM relay_region_rehome_attempts')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.attempt_id).toBe(request.attemptId)
    expect(Number(attempts[0]!.source_generation)).toBe(7)
  })

  it('rejects a replaced control and never substitutes a different target', async () => {
    const { store, safety, request } = await setup()
    expect(
      await store.commitIdleRegionalRehome({ ...request, targetCellId: 'missing' }, safety)
    ).toEqual({ outcome: 'deferred' })
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
    expect(await store.commitIdleRegionalRehome(request)).toEqual({ outcome: 'deferred' })
    expect(await store.commitIdleRegionalRehome(request, safety, 0)).toEqual({
      outcome: 'deferred'
    })
    expect(await database.query('SELECT * FROM relay_region_rehome_attempts')).toEqual([])
  })

  it('selects read-only with stable identity and the control generation, not probe generation', async () => {
    const { store, safety, database } = await setup()
    const before = await database.query('SELECT * FROM relay_assignments')
    const candidates = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      sourceGeneration: 7,
      sourceCellId: 'source',
      targetCellId: 'target'
    })
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual(candidates)
    expect(await database.query('SELECT * FROM relay_assignments')).toEqual(before)
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
