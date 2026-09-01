import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { listRequiredWorkerDispositions } from './worker-disposition-barrier'

describe('worker disposition query plan', () => {
  const db = new OrchestrationDb(':memory:')

  afterEach(() => db.close())

  it('uses indexed Run and accepted-report lookups', () => {
    const prepare = db.db.prepare.bind(db.db)
    const statements: string[] = []
    vi.spyOn(db.db, 'prepare').mockImplementation((sql: string) => {
      statements.push(sql)
      return prepare(sql)
    })
    listRequiredWorkerDispositions(db, 'run_probe')
    vi.restoreAllMocks()

    const plans = statements
      .filter((sql) => sql.includes('worker_report_settled_at') || sql.includes('INDEXED BY'))
      .map((sql) =>
        prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(sql.includes('INDEXED BY') ? 'run_probe' : 'ctx_probe')
          .map((row) => (row as { detail: string }).detail)
      )
    expect(plans[0]).toContainEqual(expect.stringContaining('idx_dispatch_run_status'))
    expect(plans[1]).toContainEqual(expect.stringContaining('dispatch_id=?'))
    expect(plans.flat()).not.toContainEqual(
      expect.stringMatching(/^SCAN (current|worker_dispatches)$/)
    )
  })
})
