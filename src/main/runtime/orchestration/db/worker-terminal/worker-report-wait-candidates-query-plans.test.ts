import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { plansOf } from '../query-plan-capture.test-support'
import { createRootDispatch } from '../root-dispatch-test-fixture'

describe('empty-check hint candidates', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it("read live work through indexes, never the Run's whole Dispatch history", () => {
    const run = db.createRun({
      objective: 'Long Run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    createRootDispatch(db, db.createTask({ runId: run.id, spec: 'running' }).id, 'term_worker')

    const plans = plansOf(db, ['dispatch_contexts'], () =>
      db.listWorkerReportWaitCandidates(run.id)
    )

    expect(plans.filter((detail) => /^SCAN (d|dispatch_contexts)\b/.test(detail))).toEqual([])
    expect(plans).not.toContain('SEARCH d USING INDEX idx_dispatch_run_status (run_id=?)')
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.stringContaining('idx_dispatch_contexts_run'),
        expect.stringContaining('idx_worker_dispatches_agent_terminal_handle'),
        'SEARCH d USING INDEX sqlite_autoindex_dispatch_contexts_1 (id=?)'
      ])
    )
  })
})
