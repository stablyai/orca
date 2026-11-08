import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../../../../../shared/timer-delay'
import { ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS } from '../../../../../../shared/orchestration/orchestration-timing-budgets'
import { resolveFederatedWorkerStartBudgets } from './worker-start-budgets'

describe('worker-start transport budgets', () => {
  it('does not silently shorten an overflowing request', () => {
    const timeoutMs = MAX_TIMER_DELAY_MS - ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS + 1
    expect(() => resolveFederatedWorkerStartBudgets(timeoutMs, 1_000)).toThrow(
      'derived timeout must fit'
    )
  })
})
