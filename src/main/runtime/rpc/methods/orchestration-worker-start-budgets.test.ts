import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'
import {
  ORCHESTRATION_READINESS_TIMEOUT_MS,
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
} from '../../../../shared/orchestration-timing-budgets'
import { resolveFederatedWorkerStartBudgets } from './orchestration-worker-start-budgets'

describe('worker-start transport budgets', () => {
  it('keeps the exact maximum derived timeout representable', () => {
    const timeoutMs = MAX_TIMER_DELAY_MS - ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
    const budgets = resolveFederatedWorkerStartBudgets(timeoutMs, 1_000)
    expect(budgets.outerDeadlineMs).toBe(1_000 + MAX_TIMER_DELAY_MS)
  })

  it('does not silently shorten an overflowing request', () => {
    const timeoutMs = MAX_TIMER_DELAY_MS - ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS + 1
    expect(() => resolveFederatedWorkerStartBudgets(timeoutMs, 1_000)).toThrow(
      'derived timeout must fit'
    )
  })

  it('normalizes non-positive requests to the ordinary readiness default', () => {
    const expectedOuterDeadline =
      1_000 + ORCHESTRATION_READINESS_TIMEOUT_MS + ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
    expect(resolveFederatedWorkerStartBudgets(0, 1_000).readinessTimeoutMs).toBe(
      ORCHESTRATION_READINESS_TIMEOUT_MS
    )
    expect(resolveFederatedWorkerStartBudgets(0, 1_000).outerDeadlineMs).toBe(expectedOuterDeadline)
    expect(resolveFederatedWorkerStartBudgets(-1, 1_000).outerDeadlineMs).toBe(
      expectedOuterDeadline
    )
  })
})
