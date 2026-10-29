import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const databases: OrchestrationDb[] = []
afterEach(() => {
  vi.restoreAllMocks()
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
  it('walks to the root with one indexed ancestor read per link at N and 10N', () => {
    for (const depth of [4, 40]) {
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
        expect(prepare.mock.calls.length).toBeLessThanOrEqual(depth + 50)
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
      expect(bind(separate.id)?.coordinator_handle).toBe(parent.assignee_handle)
      assertWalk()
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
