import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import type { SqliteBindings } from '../sqlite/sqlite-statement'
import type { OrchestrationDb } from './orchestration/db'

// SQL predicate visits complement range plans/probe counts; they are not total SQLite VM steps.
export function installSqlVisitCounters(counters: Record<string, () => number>) {
  const initialized = new WeakSet<DatabaseSync>()
  const prepare = DatabaseSync.prototype.prepare
  return vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql
  ) {
    if (!initialized.has(this)) {
      for (const [name, visit] of Object.entries(counters)) {
        this.function(name, {}, (_rowid: unknown) => visit())
      }
      initialized.add(this)
    }
    return prepare.call(this, sql)
  })
}

export function traceDispatchPredicateVisits(
  db: SyncDatabase,
  functions: { candidate: string; latest?: string; observation?: string }
) {
  const prepare = db.prepare.bind(db)
  const executions: { query: string; parameters: SqliteBindings; rows: number }[] = []
  const observed = new WeakSet<object>()
  const trace = vi.spyOn(db, 'prepare').mockImplementation((query) => {
    let instrumented = query.replaceAll(
      'WHERE assignee_orca_session_id IS NOT NULL',
      `WHERE assignee_orca_session_id IS NOT NULL AND ${functions.candidate}(rowid)`
    )
    if (functions.latest && query.includes('rowid AS n')) {
      instrumented = instrumented.replace(
        'ORDER BY rowid DESC LIMIT 1',
        `AND ${functions.latest}(rowid) ORDER BY rowid DESC LIMIT 1`
      )
    }
    if (functions.observation) {
      instrumented = instrumented.replace(
        'WHERE dispatch_id IN',
        `WHERE ${functions.observation}(rowid) AND dispatch_id IN`
      )
    }
    const statement = prepare(instrumented)
    if (!observed.has(statement)) {
      observed.add(statement)
      const all = statement.all.bind(statement)
      const get = statement.get.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        const rows = all(...args)
        executions.push({ query, parameters: args, rows: rows.length })
        return rows
      })
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        const row = get(...args)
        executions.push({ query, parameters: args, rows: row ? 1 : 0 })
        return row
      })
    }
    return statement
  })
  return Object.assign(trace, { executions })
}

export function latestStatementMetrics(
  trace: ReturnType<typeof traceDispatchPredicateVisits>,
  native: ReturnType<typeof installSqlVisitCounters>
) {
  const latest = (query: string) => query.includes('rowid AS n FROM dispatch_contexts')
  const executions = trace.executions.filter(({ query }) => latest(query))
  return {
    cachedPrepareCalls: trace.mock.calls.filter(([query]) => latest(query)).length,
    executedStatements: executions.length,
    nativeCompilations: native.mock.calls.filter(([query]) => latest(query)).length,
    addressEntries: executions.reduce((sum, { parameters }) => {
      const addresses: unknown =
        typeof parameters[0] === 'string' ? JSON.parse(parameters[0]) : null
      if (!Array.isArray(addresses) || !addresses.every((value) => typeof value === 'string')) {
        throw new Error('Expected actual JSON address batch')
      }
      return sum + addresses.length
    }, 0),
    returnedVerificationRows: executions.reduce((sum, { rows }) => sum + rows, 0)
  }
}

export function dispatchQueryPlans(
  db: SyncDatabase,
  trace: ReturnType<typeof traceDispatchPredicateVisits>
) {
  const queries = new Map(
    trace.executions
      .filter(
        ({ query }) =>
          query.includes('idx_dispatch_session_presentation') ||
          query.includes('rowid AS n FROM dispatch_contexts')
      )
      .map(({ query, parameters }) => [query, parameters])
  )
  return [...queries].map(([query, parameters]) => ({
    query,
    parameters,
    plan: db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters)
  }))
}

export function seedCoarsePresentationDispatches(
  db: OrchestrationDb,
  runId: string,
  count: number,
  now: number,
  prefix = 'coarse'
) {
  if (!count) {
    return
  }
  const task = db.createTask({ runId, spec: 'coarse-only history' })
  db.db
    .prepare(`INSERT INTO dispatch_contexts
    (id, run_id, task_id, assignee_handle, assignee_orca_session_id, status, completed_at)
    WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
    SELECT ? || n, ?, ?, CASE WHEN n % 2 = 1 THEN ? || n WHEN n % 4 = 0 THEN '' ELSE NULL END,
      ? || n, 'completed', ? FROM seq`)
    .run(
      count,
      `${prefix}-id-`,
      runId,
      task.id,
      `${prefix}-handle-`,
      `${prefix}-session-`,
      new Date(now - 7_200_000).toISOString()
    )
}
