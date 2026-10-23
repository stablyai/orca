import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import { sameExactCaller } from './db/runs/run-actor'
import { findCallerWorkerDispatches } from './db/runs/worker-run-binding'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
const homes: string[] = []
const databases: OrchestrationDb[] = []
afterEach(() => {
  vi.restoreAllMocks()
  hostRef.current = null
  closeTestJournalHostDatabases()
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function openDatabase(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  return db
}

// Count real SQLite date evaluations, forwarding to SQLite's unchanged implementation on a second connection.
function historyWork(db: OrchestrationDb) {
  const adapter: unknown = db.db
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('db' in adapter) ||
    !(adapter.db instanceof DatabaseSync)
  ) {
    throw new Error('Expected node:sqlite database')
  }
  const native = adapter.db
  const oracle = new DatabaseSync(':memory:')
  const date = oracle.prepare('SELECT julianday(?) AS value')
  let evaluations = 0
  native.function('julianday', { deterministic: true }, (value) => {
    evaluations++
    return date.get(value)?.value ?? null
  })
  return {
    reset: () => {
      evaluations = 0
    },
    count: () => evaluations,
    close: () => oracle.close()
  }
}

describe('Run binding scaling contracts', () => {
  it('confirms the current Task owner without materializing prior attempts at N and 10N', () => {
    const counts: number[] = []
    for (const history of [4, 40]) {
      const db = openDatabase()
      const parent = db.createRun({
        objective: 'parent',
        coordinatorHandle: 'root',
        coordinatorPaneKey: null
      })
      const task = db.createTask({ runId: parent.id, spec: 'retained Task' })
      const insert = db.db.prepare(`INSERT INTO dispatch_contexts
        (id, task_id, run_id, assignee_handle, creator_handle, status)
        VALUES (?, ?, ?, ?, 'root', 'completed')`)
      for (let row = 0; row < history; row++) {
        insert.run(`history_${row}`, task.id, parent.id, `old_${row}`)
      }
      createRootDispatch(db, task.id, 'worker', 'pane-worker', undefined, 'process-worker')
      const child = db.createRun({
        objective: 'child',
        coordinatorHandle: 'worker',
        coordinatorPaneKey: 'pane-worker',
        processIncarnation: 'process-worker'
      })
      const before = db.getRunRaw(child.id)
      let rows = 0
      const observed = new WeakSet<object>()
      const originalPrepare = db.db.prepare.bind(db.db)
      const prepare = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        const statement = originalPrepare(sql)
        if (sql.includes('FROM dispatch_contexts') && !observed.has(statement)) {
          observed.add(statement)
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...params) => {
            const result = all(...params)
            rows += result.length
            return result
          })
        }
        return statement
      })
      expect(
        db.bindRun({
          runId: child.id,
          coordinatorHandle: 'worker',
          coordinatorPaneKey: 'pane-worker',
          processIncarnation: 'process-worker'
        })
      ).toMatchObject({ id: child.id })
      expect(rows).toBe(1)
      counts.push(prepare.mock.calls.length)
      expect(db.getRunRaw(child.id)).toEqual(before)
      prepare.mockRestore()
    }
    expect(counts[1]).toBe(counts[0])
  })

  it('walks to the root with one indexed ancestor read per link at N and 10N', () => {
    for (const [depth, vertices] of [
      [4, 4],
      [40, 4],
      [4, 40],
      [40, 40]
    ]) {
      const db = openDatabase()
      const root = db.createRun({
        objective: 'root',
        coordinatorHandle: 'root',
        coordinatorPaneKey: null
      })
      const child = db.createRun({
        objective: 'child',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      let ancestor = child
      for (let n = 1; n < vertices; n++) {
        const next = db.createRun({
          objective: 'ancestor',
          coordinatorHandle: null,
          coordinatorPaneKey: null
        })
        const task = db.createTask({ runId: next.id, spec: 'joined owner' })
        db.db
          .prepare('UPDATE run_authority SET parent_run_id = ?, owner_task_id = ? WHERE run_id = ?')
          .run(next.id, task.id, ancestor.id)
        ancestor = next
      }
      let parent = createRootDispatch(
        db,
        db.createTask({ spec: 'root work', runId: root.id }).id,
        'worker_0'
      )
      for (let link = 1; link <= depth; link++) {
        parent = db.createDispatchContext({
          taskId: db.createTask({ spec: 'child work', runId: child.id }).id,
          assigneeHandle: `worker_${link}`,
          creator: { kind: 'terminal', handle: `worker_${link - 1}` },
          maxDepth: Number.MAX_SAFE_INTEGER
        })
      }
      const separate = db.createRun({
        objective: 'handoff',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const before = db.getRunRaw(root.id)
      const taskReads = vi.spyOn(db, 'getTask')
      const reads: string[] = []
      const observed = new WeakSet<object>()
      const originalPrepare = db.db.prepare.bind(db.db)
      const prepare = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        const statement = originalPrepare(sql)
        if (/FROM dispatch_contexts WHERE id = \?/.test(sql) && !observed.has(statement)) {
          observed.add(statement)
          const get = statement.get.bind(statement)
          vi.spyOn(statement, 'get').mockImplementation((...params) => {
            reads.push(sql)
            return get(...params)
          })
        }
        return statement
      })
      const bind = (runId: string) =>
        db.bindRun({
          runId,
          coordinatorHandle: parent.assignee_handle,
          coordinatorPaneKey: null
        })
      const assertWalk = () => {
        expect(reads).toHaveLength(depth)
        expect(taskReads).toHaveBeenCalledTimes(depth * (vertices - 1))
        expect(prepare.mock.calls.length).toBeLessThanOrEqual(6 * depth * vertices + 50)
        const sql = reads[0]
        expect(sql).toBeDefined()
        expect(db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('absent')).toContainEqual(
          expect.objectContaining({
            detail: expect.stringMatching(/SEARCH dispatch_contexts USING INDEX .*\(id=\?\)/)
          })
        )
      }
      expect(() => bind(root.id)).toThrow(
        expect.objectContaining({ code: 'worker_cannot_coordinate_own_run' })
      )
      assertWalk()
      expect(db.getRunRaw(root.id)).toEqual(before)
      prepare.mockClear()
      reads.length = 0
      taskReads.mockClear()
      expect(() => bind(separate.id)).toThrow(
        expect.objectContaining({ code: 'run_ownership_required' })
      )
      assertWalk()
      db.db
        .prepare('UPDATE run_authority SET parent_run_id = ? WHERE run_id = ?')
        .run(child.id, ancestor.id)
      expect(() => bind(separate.id)).toThrow(/cycle/)
      expect(db.getRunRaw(separate.id)?.coordinator_handle).toBeNull()
      taskReads.mockRestore()
      prepare.mockRestore()
    }
  })

  it.each([
    [4, 2],
    [40, 2],
    [4, 20]
  ])(
    'bounds four real alias consumers with %i historical Dispatches and %i unread messages per alias',
    (history, messages) => {
      const db = openDatabase()
      const run = db.createRun({
        objective: 'historical aliases',
        coordinatorHandle: 'coord',
        coordinatorPaneKey: null
      })
      const other = db.createRun({
        objective: 'unrelated history',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const task = db.createTask({ spec: 'retained work', runId: run.id })
      const otherTask = db.createTask({ spec: 'unrelated retained work', runId: other.id })
      const sessionId = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
      const aliases = ['old_coord', 'old_worker', formatOrcaSessionAddress(sessionId)]
      const insert = db.db.prepare(`INSERT INTO dispatch_contexts
        (id, task_id, run_id, assignee_handle, assignee_orca_session_id, creator_handle, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'coord', 'completed', '2000-01-01', ?)`)
      for (const [index, alias] of aliases.entries()) {
        db.rememberRunCoordinatorHandle(run.id, alias)
        for (let row = 0; row < history; row++) {
          insert.run(
            `history_${index}_${row}`,
            task.id,
            run.id,
            index === 0 ? alias : 'old_worker',
            index === 0 ? null : sessionId,
            index > 0 && row === history - 1 ? '2000-01-04' : '2000-01-02'
          )
        }
      }
      for (let row = 0; row < history * 10; row++) {
        insert.run(`unrelated_${row}`, otherTask.id, other.id, 'old_coord', null, '2000-01-04')
      }
      db.db
        .prepare('UPDATE run_coordinator_handles SET first_bound_at = ? WHERE run_id = ?')
        .run('2000-01-03', run.id)
      const work = historyWork(db)
      const prepare = vi.spyOn(db.db, 'prepare')
      const ids = new Map<string, string[]>()
      const assertWork = (messageMultiplier: number) => {
        // Each alias history is visited, but no unrelated Run or quadratic history join is needed.
        expect(work.count()).toBeGreaterThanOrEqual(history)
        expect(work.count()).toBeLessThanOrEqual(24 * history * messageMultiplier)
        expect(prepare.mock.calls.length).toBeLessThanOrEqual(12 * messageMultiplier + 12)
        for (const [sql] of prepare.mock.calls.filter(
          ([query]) =>
            query.includes('FROM dispatch_contexts AS grab') && !query.startsWith('EXPLAIN')
        )) {
          const plan = db.db
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...Array(sql.match(/\?/g)?.length ?? 0).fill(null))
          expect(plan).toContainEqual(
            expect.objectContaining({
              detail: expect.stringMatching(/SEARCH grab(?: EXISTS)? USING INDEX .*\(run_id=\?\)/)
            })
          )
          expect(plan).not.toContainEqual(
            expect.objectContaining({ detail: expect.stringMatching(/SCAN grab/) })
          )
        }
        work.reset()
        prepare.mockClear()
      }
      const restoreDirect = () => {
        for (const [alias, messageIds] of ids) {
          for (const id of messageIds) {
            db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(alias, id)
          }
        }
        work.reset()
        prepare.mockClear()
      }
      try {
        for (const alias of aliases) {
          expect(db.getRunMailboxOwnerIdsForHandle(alias)).toEqual(
            alias === 'old_coord' ? [run.id] : []
          )
        }
        assertWork(1)

        // Production INSERT fires the actual routing trigger, including both address spellings.
        for (const alias of aliases) {
          const messageIds: string[] = []
          for (let message = 0; message < messages; message++) {
            const inserted = db.insertMessage({
              from: 'coord',
              to: alias,
              runId: run.id,
              subject: 'direct'
            })
            expect(inserted.to_handle).toBe(alias === 'old_coord' ? `run:${run.id}` : alias)
            messageIds.push(inserted.id)
          }
          ids.set(alias, messageIds)
        }
        assertWork(messages)

        // Restored pre-upgrade direct mail is swept by binding and foreign-mail reconciliation.
        restoreDirect()
        for (const alias of aliases) {
          db.routeAllUnreadDirectMessagesToRunMailbox(run.id, alias)
        }
        assertWork(messages)
        for (const [alias, messageIds] of ids) {
          for (const id of messageIds) {
            expect(db.getMessageById(id)?.to_handle).toBe(
              alias === 'old_coord' ? `run:${run.id}` : alias
            )
          }
        }
        restoreDirect()
        for (const alias of aliases) {
          expect(db.routeForeignDirectMessagesToOwnedMailboxes(alias).routedCount).toBe(
            alias === 'old_coord' ? messages : 0
          )
        }
        assertWork(messages)
        for (const [alias, messageIds] of ids) {
          for (const id of messageIds) {
            expect(db.getMessageById(id)?.to_handle).toBe(
              alias === 'old_coord' ? `run:${run.id}` : alias
            )
          }
        }
      } finally {
        work.close()
      }
    }
  )
})

it.each([
  [100, 4, 4],
  [1000, 4, 4],
  [100, 40, 4],
  [100, 4, 40],
  [100, 40, 40]
])(
  'bounds published identity work at S=%i H=%i L=%i through binding and ambiguity',
  async (size, history, length) => {
    const home = mkdtempSync(join(tmpdir(), 'orca-run-snapshot-'))
    homes.push(home)
    const ids = Array.from({ length: size }, (_, n) =>
      testOrcaSessionId(`${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`)
    )
    const records = ids.map((sessionId) =>
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    )
    for (let n = 0; n < length; n++) {
      records[n].conversationCommand = {
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        replacementSessionId: ids[n + 1],
        operationId: `clear-${n}`,
        callerKey: 'test'
      }
    }
    await seedTestAgentSessionRecordStore(home, { records })
    const store = await openTestAgentSessionRecordStore(home)
    const db = openDatabase()
    const parent = db.createRun({
      objective: 'parent',
      coordinatorHandle: 'root',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: parent.id, spec: 'retained work' })
    const insert = db.db.prepare(`INSERT INTO dispatch_contexts
        (id, task_id, run_id, assignee_handle, assignee_orca_session_id, creator_handle, status)
        VALUES (?, ?, ?, ?, ?, 'root', ?)`)
    for (let n = 0; n < history; n++) {
      insert.run(
        `old_${n}`,
        task.id,
        parent.id,
        `old_${n}`,
        n === history - 1 ? ids[length + 1] : ids[(n % length) + 1],
        'completed'
      )
    }
    const current = createRootDispatch(db, task.id, 'worker', 'pane', undefined, 'process')
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(ids[length + 2], current.id)
    const caller = {
      coordinatorHandle: 'worker',
      coordinatorPaneKey: 'pane',
      coordinatorOrcaSessionId: ids[length + 2],
      processIncarnation: 'process'
    }
    const child = db.createRun({ objective: 'child', ...caller })
    const seat = (id: (typeof ids)[number]) =>
      db.bindRun({
        runId: child.id,
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: id
      })
    seat(ids[length + 3])
    const snapshot = store.getRecordSnapshot()
    let visits = 0,
      edgeWork = 0,
      historyRows = 0,
      candidates = 0
    const values = snapshot.values.bind(snapshot)
    vi.spyOn(snapshot, 'values').mockImplementation(function* () {
      for (const record of values()) {
        visits++
        yield record
      }
      return undefined
    })
    const copies = vi.spyOn(store, 'listRecords')
    const maps = new WeakSet<object>(),
      identityIds = new Set<string>(ids)
    const set = Map.prototype.set,
      get = Map.prototype.get
    const memoWrites = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value
    ) {
      if (typeof value === 'string' && typeof key === 'string' && identityIds.has(key)) {
        maps.add(this)
      }
      return set.call(this, key, value)
    })
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key) {
      if (maps.has(this)) {
        edgeWork++
      }
      return get.call(this, key)
    })
    const prepare = db.db.prepare.bind(db.db),
      observed = new WeakSet<object>()
    vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (sql.includes('FROM dispatch_contexts') && !observed.has(statement)) {
        observed.add(statement)
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          const rows = all(...args)
          if (sql.includes('WHERE task_id = ? AND id != ?')) {
            historyRows += rows.length
          } else {
            candidates += rows.length
          }
          return rows
        })
      }
      return statement
    })
    hostRef.current = { deps: { store } }
    db.bindRun({ runId: parent.id, coordinatorHandle: 'root', coordinatorPaneKey: null })
    expect(visits).toBe(0)
    const bind = () =>
      db.bindRun({
        runId: child.id,
        ...caller,
        probed: {
          consumerGeneration: db.getRunRaw(child.id)?.consumer_generation ?? -1,
          liveLabel: 'live'
        }
      })
    const before = db.getRunRaw(child.id)
    expect(bind).toThrow(expect.objectContaining({ code: 'run_coordinator_live' }))
    expect(db.getRunRaw(child.id)).toEqual(before)
    expect([visits, historyRows, candidates]).toEqual([size, history, 1])
    seat(ids[length + 1])
    historyRows = candidates = 0
    expect(bind()).toMatchObject({ coordinator_handle: 'worker' })
    expect([historyRows, candidates]).toEqual([history, 1])
    historyRows = candidates = 0
    expect(bind()).toMatchObject({ coordinator_handle: 'worker' })
    expect([visits, historyRows, candidates]).toEqual([size, 0, 1])
    const priorWork = edgeWork
    for (let n = 0; n < 40; n++) {
      expect(canonicalOrcaSessionId(ids[length])).toBe(ids[0])
    }
    expect(edgeWork - priorWork).toBeLessThanOrEqual(2 * length + 80)
    expect(edgeWork).toBeLessThan(20 * (length + history + 20))
    for (const count of [4, 40]) {
      db.db.exec("DELETE FROM dispatch_contexts WHERE id LIKE 'ambiguous_%'")
      for (let n = 1; n < count; n++) {
        insert.run(
          `ambiguous_${n}`,
          task.id,
          parent.id,
          `ambiguous_${n}`,
          ids[length + 2],
          'dispatched'
        )
      }
      db.db
        .prepare(`UPDATE dispatch_contexts SET creator_orca_session_id = ?, assignee_handle = 'worker'
          WHERE id LIKE 'ambiguous_%'`)
        .run(ids[length])
      const candidateWork = edgeWork
      candidates = 0
      expect(bind).toThrow(expect.objectContaining({ code: 'run_ownership_required' }))
      expect(candidates).toBe(count)
      expect(edgeWork - candidateWork).toBeLessThanOrEqual(8 * count + 20)
      expect(db.getRunRaw(child.id)?.coordinator_handle).toBe('worker')
      db.db
        .prepare(`UPDATE dispatch_contexts SET assignee_orca_session_id = ?
          WHERE id LIKE 'ambiguous_%'`)
        .run(ids[1])
      const selfContextWork = edgeWork
      candidates = 0
      expect(
        findCallerWorkerDispatches(db, {
          terminalHandle: 'worker',
          paneKey: 'pane',
          orcaSessionId: ids[length + 2]
        }).map((row) => row.id)
      ).toEqual([current.id])
      expect(candidates).toBe(count)
      expect(edgeWork - selfContextWork).toBeLessThanOrEqual(4 * count)
    }
    expect(visits).toBe(size)
    expect(copies).not.toHaveBeenCalled()
    const writes = memoWrites.mock.calls.length
    for (const id of ids.slice(length + 4)) {
      expect(canonicalOrcaSessionId(id)).toBe(id)
    }
    expect(memoWrites).toHaveBeenCalledTimes(writes)
  }
)

it('preserves exceptional lineage, old readers, and exact-caller parity', () => {
  const [a, b, c] = [1, 2, 3].map((n) =>
    testOrcaSessionId(`${n}1111111-1111-4111-8111-111111111111`)
  )
  const cases = [
    { paths: [[a, b, c]], answers: [a, a, a] },
    {
      paths: [
        [a, c],
        [b, c]
      ],
      answers: [a, b, b]
    },
    { paths: [['invalid', b, c]], answers: [a, b, c] },
    { paths: [[a, b, a]], answers: [b, a, c] }
  ]
  for (const { paths, answers } of cases) {
    const edges = paths.flatMap((path) => path.slice(1).map((next, n) => [path[n], next]))
    const records = edges.map(([sessionId, replacementSessionId]) => ({
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
      conversationCommand: {
        command: 'clear' as const,
        state: 'completed' as const,
        phase: 'committed' as const,
        replacementSessionId,
        operationId: 'clear',
        callerKey: 'test'
      }
    }))
    const old = { getRecord: () => null, listRecords: vi.fn(() => records) }
    const snapshot = new Map(records.map((record) => [record.sessionId, record]))
    for (const reader of [old, { ...old, getRecordSnapshot: () => snapshot }]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        expect([a, b, c].map((id) => canonicalOrcaSessionId(id, reader))).toEqual(answers)
      }
    }
    expect(old.listRecords).toHaveBeenCalledTimes(6)
    const prepared = records.map((record) => ({
      ...record,
      conversationCommand: { ...record.conversationCommand, phase: 'prepared' as const }
    }))
    expect(canonicalOrcaSessionId(c, { ...old, listRecords: () => prepared })).toBe(c)
  }
  expect(canonicalOrcaSessionId(a, null)).toBe(a)
  const key = (
    orcaSessionId: typeof a | null,
    paneKey = 'pane',
    processIncarnation: string | null = 'p'
  ) => ({ terminalHandle: null, orcaSessionId, paneKey, processIncarnation })
  expect(sameExactCaller(key(a), key(a, 'other', 'other'))).toBe(true)
  expect(sameExactCaller(key(a), key(b))).toBe(false)
  expect(sameExactCaller(key(null), key(null))).toBe(true)
  expect(sameExactCaller(key(null), key(null, 'pane', null))).toBe(false)
})
