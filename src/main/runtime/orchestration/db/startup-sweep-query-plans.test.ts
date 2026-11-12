import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { recentOpenApprovalReports } from '../workers/approvals/worker-approval-report'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'

/** The query plan of every statement `act` prepares that reads one of `tables`. */
function plansOf(db: OrchestrationDb, tables: string[], act: () => void): string[] {
  const prepare = vi.spyOn(db.db, 'prepare')
  act()
  const statements = prepare.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /^\s*SELECT/i.test(sql) && tables.some((table) => sql.includes(table)))
  prepare.mockRestore()
  expect(statements.length).toBeGreaterThan(0)
  return statements.flatMap((sql) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EXPLAIN QUERY PLAN rows carry a detail column.
    (db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
      ({ detail }) => detail
    )
  )
}

const fullScans = (plans: string[]): string[] =>
  plans.filter((detail) => /^SCAN \w+$/.test(detail.trim()))

describe('open-time sweeps read through their indexes, not all history', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('the restart approval sweep reads only stop reports', () => {
    const plans = plansOf(db, ['messages'], () => recentOpenApprovalReports(db))
    expect(fullScans(plans)).toEqual([])
    expect(plans.filter((detail) => detail.includes('idx_messages_stop_reports'))).toHaveLength(2)
  })

  it('legacy worker recovery reads only live workers', () => {
    const plans = plansOf(db, ['dispatch_contexts'], () =>
      db.listLegacyWorkerTerminalRecoveryRows()
    )
    expect(fullScans(plans)).toEqual([])
    expect(plans).toEqual(
      expect.arrayContaining([expect.stringContaining('idx_worker_dispatches_recoverable')])
    )
  })

  it('the Orca session backfill reads only rows it may still fill', () => {
    const plans = plansOf(db, ['dispatch_contexts'], () =>
      backfillStructuredWorkerOrcaSessionIds(db.db)
    )
    expect(fullScans(plans)).toEqual([])
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.stringContaining('idx_dispatch_assignee_orca_session_backfill'),
        expect.stringContaining('idx_dispatch_creator_orca_session_backfill')
      ])
    )
  })
})
