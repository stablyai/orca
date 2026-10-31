import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { installSqlVisitCounters } from '../../../../dispatch-predicate-visits.test-fixture'

/** How a follow-up's caller check reads saved custody: each statement by its SQL, the index its ranges must use, and
 *  the probes each row it reads may make. */
const CALLER_READS = {
  history: {
    match: (sql: string) => sql.startsWith('WITH holders AS'),
    index: 'idx_dispatch_pane_leaf_history',
    // One custody-owner and one worker-row probe per holder.
    probes: [/SEARCH r USING .*idx_worker_terminal_resources_owner/, /SEARCH w USING /]
  },
  identity: {
    match: (sql: string) =>
      sql ===
      'SELECT * FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?',
    index: 'idx_worker_terminal_resources_identity',
    probes: []
  },
  formerOwner: {
    match: (sql: string) => sql.includes('prior_owner_dispatch_ids LIKE'),
    index: '',
    probes: []
  }
}
type CallerRead = keyof typeof CALLER_READS

/** Executions of the caller's custody reads, the rows visited inside their index ranges, and their executed plans. */
export function traceCallerReads(db: OrchestrationDb, extraProbes: RegExp[] = []) {
  const visited: Record<CallerRead, number> = { history: 0, identity: 0, formerOwner: 0 }
  const executions: { read: CallerRead; query: string; parameters: unknown[] }[] = []
  const native = installSqlVisitCounters({
    caller_read_history: () => ++visited.history,
    caller_read_identity: () => ++visited.identity
  })
  const prepare = db.db.prepare.bind(db.db)
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((query) => {
    const read = (Object.keys(CALLER_READS) as CallerRead[]).find((name) =>
      CALLER_READS[name].match(query)
    )
    if (!read) {
      return prepare(query)
    }
    // Counted after the leading range column, so only rows inside each range are visited.
    const statement = prepare(
      query.replaceAll('= ? AND host_scope', `= ? AND caller_read_${read}(rowid) AND host_scope`)
    )
    const all = statement.all.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
      executions.push({ read, query, parameters })
      return all(...parameters)
    })
    return statement
  })
  return {
    counts: () =>
      Object.fromEntries(
        (Object.keys(CALLER_READS) as CallerRead[]).map((read) => [
          read,
          {
            executions: executions.filter((execution) => execution.read === read).length,
            visited: visited[read]
          }
        ])
      ),
    /** Every executed read uses its ranges and probes, and scans no table. */
    expectIndexedPlans() {
      for (const { read, query, parameters } of executions) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...(parameters as string[]))
          .map((row) => String((row as { detail: string }).detail))
        const { index, probes } = CALLER_READS[read]
        expect(plan.filter((detail) => detail.includes(index)).length).toBeGreaterThan(0)
        for (const probe of read === 'history' ? [...probes, ...extraProbes] : probes) {
          expect(plan).toContainEqual(expect.stringMatching(probe))
        }
        expect(plan.filter((detail) => /^SCAN (?!h\b)/.test(detail))).toEqual([])
      }
      return executions.map(({ read }) => read)
    },
    restore() {
      spy.mockRestore()
      native.mockRestore()
    }
  }
}

/** Settled work that shares nothing with a caller's chain but sits beside it in every index it reads: other panes and
 *  processes, and this pane and process on another host. */
export function seedUnrelatedHistory(
  db: OrchestrationDb,
  runId: string,
  count: number,
  near: { pane: string; incarnation: string; host: string | null }
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
              CASE WHEN n % 4 = 0 THEN 'another host' ELSE ? END, 'completed'
         FROM seq`
    )
    .run(count, prefix, runId, task.id, near.pane, prefix, near.incarnation, prefix, near.host)
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key, process_incarnation, host_scope, ownership_state)
       SELECT 'wtr_' || id, id, id, assignee_handle, assignee_pane_key, process_incarnation, host_scope, 'external'
         FROM dispatch_contexts WHERE id LIKE ? || '%'`
    )
    .run(prefix)
}
