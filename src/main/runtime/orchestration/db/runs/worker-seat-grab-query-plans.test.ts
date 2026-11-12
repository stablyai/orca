import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { plansOf } from '../query-plan-capture.test-support'

describe('worker seat-grab check', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it("reads the address's own Dispatches, not every Dispatch in the Run", () => {
    const plans = plansOf(db, ['dispatch_contexts'], () =>
      db.getRunMailboxOwnerIdsForHandle('term_coordinator')
    )

    expect(plans.filter((detail) => detail.includes('idx_dispatch_run_status'))).toEqual([])
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.stringContaining('idx_dispatch_assignee_handle'),
        expect.stringContaining('idx_dispatch_assignee_orca_session_id')
      ])
    )
  })
})
