import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { SqliteBindings, SqliteRow } from '../../../../../sqlite/sqlite-statement'
import { installSqlVisitCounters } from '../../../../dispatch-predicate-visits.test-fixture'

const CALLER_READ_NAMES = ['identity', 'formerOwner'] as const
type CallerRead = (typeof CALLER_READ_NAMES)[number]

/** How a follow-up's caller check reads saved custody: each statement by its SQL and the index its range must use. */
const CALLER_READS: Record<CallerRead, { match: (sql: string) => boolean; index: string }> = {
  identity: {
    match: (sql: string) =>
      sql ===
      'SELECT * FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?',
    index: 'idx_worker_terminal_resources_identity'
  },
  formerOwner: {
    match: (sql: string) => sql.includes('prior_owner_dispatch_ids LIKE'),
    index: ''
  }
}

/** Executions of the caller's custody reads, the rows visited inside their index ranges, every field read off the rows
 *  they return, and their executed plans. */
export function traceCallerReads(db: OrchestrationDb) {
  const visited: Record<CallerRead, number> = { identity: 0, formerOwner: 0 }
  const fieldReads: Record<CallerRead, number> = { identity: 0, formerOwner: 0 }
  const executions: { read: CallerRead; query: string; parameters: SqliteBindings }[] = []
  const native = installSqlVisitCounters({
    caller_read_identity: () => ++visited.identity,
    caller_read_formerOwner: () => ++visited.formerOwner
  })
  // Each returned row counts its field reads, so work per row is measured whatever the caller keeps.
  const counted = (read: CallerRead, row: SqliteRow) =>
    new Proxy(row, {
      get: (target, field) => {
        fieldReads[read]++
        return typeof field === 'string' ? target[field] : undefined
      }
    })
  const prepare = db.db.prepare.bind(db.db)
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((query) => {
    const read = CALLER_READ_NAMES.find((name) => CALLER_READS[name].match(query))
    if (!read) {
      return prepare(query)
    }
    // Counted after the leading range column, so only rows inside each range are visited.
    const statement = prepare(
      query
        .replaceAll('= ? AND host_scope', `= ? AND caller_read_${read}(rowid) AND host_scope`)
        .replace(
          'WHERE prior_owner_dispatch_ids',
          `WHERE caller_read_${read}(rowid) AND prior_owner_dispatch_ids`
        )
    )
    const all = statement.all.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
      executions.push({ read, query, parameters })
      return all(...parameters).map((row) => counted(read, row))
    })
    const get = statement.get.bind(statement)
    vi.spyOn(statement, 'get').mockImplementation((...parameters) => {
      executions.push({ read, query, parameters })
      const row = get(...parameters)
      return row && counted(read, row)
    })
    return statement
  })
  return {
    counts: () =>
      Object.fromEntries(
        CALLER_READ_NAMES.map((read) => [
          read,
          {
            executions: executions.filter((execution) => execution.read === read).length,
            visited: visited[read],
            fieldReads: fieldReads[read]
          }
        ])
      ),
    /** Every executed read uses its index range and scans no table. */
    expectIndexedPlans() {
      for (const { read, query, parameters } of executions) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...parameters)
          .map((row) => String(row.detail))
        expect(plan).toContainEqual(expect.stringContaining(CALLER_READS[read].index))
        expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
      }
      return executions.map(({ read }) => read)
    },
    restore() {
      spy.mockRestore()
      native.mockRestore()
    }
  }
}

/** Settled work beside a caller's chain in every index it reads: other panes and processes, and every fourth row on
 *  this pane and process, on another host unless `host` names the chain's own. */
export function seedUnrelatedHistory(
  db: OrchestrationDb,
  runId: string,
  count: number,
  near: { pane: string; incarnation: string; host: string | null },
  host: string | null = 'another host'
) {
  const task = db.createTask({ runId, spec: 'unrelated history' })
  const prefix = `unrelated_${count}_${near.incarnation}_`
  db.db
    .prepare(
      `INSERT INTO dispatch_contexts
         (id, run_id, task_id, assignee_handle, assignee_pane_key, process_incarnation, host_scope, status)
       WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       SELECT ? || n, ?, ?, 'term_unrelated',
              CASE WHEN n % 4 = 0 THEN ? ELSE 'tab_unrelated:' || ? || n END,
              CASE WHEN n % 4 = 0 THEN ? ELSE 'process:unrelated:' || ? || n END,
              CASE WHEN n % 4 = 0 THEN ? ELSE ? END, 'completed'
         FROM seq`
    )
    .run(
      count,
      prefix,
      runId,
      task.id,
      near.pane,
      prefix,
      near.incarnation,
      prefix,
      host,
      near.host
    )
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key, process_incarnation, host_scope, ownership_state)
       SELECT 'wtr_' || id, id, id, assignee_handle, assignee_pane_key, process_incarnation, host_scope, 'external'
         FROM dispatch_contexts WHERE id LIKE ? || '%'`
    )
    .run(prefix)
}

/** Calls of the per-Dispatch reads, by method and Dispatch id. */
export function traceDispatchProbes(db: OrchestrationDb) {
  const calls = new Map<string, number>()
  const count = (call: string) => calls.set(call, (calls.get(call) ?? 0) + 1)
  const dispatch = db.getDispatchContextById.bind(db)
  const owner = db.getWorkerTerminalResourceByOwner.bind(db)
  const spies = [
    vi.spyOn(db, 'getDispatchContextById').mockImplementation((id) => {
      count(`dispatch ${id}`)
      return dispatch(id)
    }),
    vi.spyOn(db, 'getWorkerTerminalResourceByOwner').mockImplementation((id) => {
      count(`owner ${id}`)
      return owner(id)
    })
  ]
  return {
    counts: () => ({
      total: [...calls.values()].reduce((sum, count) => sum + count, 0),
      perDispatch: Math.max(...calls.values())
    }),
    restore: () => spies.forEach((spy) => spy.mockRestore())
  }
}
