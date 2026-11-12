import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { plansOf } from '../query-plan-capture.test-support'

describe('outstanding mailbox Delivery lookups', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('read the outstanding index instead of every Delivery ever taken', () => {
    const plans = plansOf(db, ['deliveries'], () => {
      db.hasOutstandingMailboxDelivery('run:run_a')
      db.getOutstandingMailboxDelivery('run:run_a')
      db.fenceUnacknowledgedMailboxDeliveries('run:run_a')
    })

    expect(plans.filter((detail) => detail.startsWith('SCAN deliveries'))).toEqual([])
    expect(
      plans.filter((detail) => detail.includes('idx_deliveries_one_outstanding'))
    ).toHaveLength(3)
  })
})
