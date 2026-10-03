import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../../../../../shared/timer-delay'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  ORCHESTRATION_READINESS_TIMEOUT_MS,
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS,
  resolveStructuredWorkerPreambleBudgetMs
} from '../../../../../../shared/orchestration-timing-budgets'
import { resolveFederatedWorkerStartBudgets } from './worker-start-budgets'

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

describe('a structured worker preamble budget', () => {
  it('always ends inside the client grace a worker start gets, and never past the readiness wait', () => {
    for (const timeoutMs of [1_000, 10_000, 60_000, 600_000]) {
      for (const spentMs of [0, timeoutMs / 2, timeoutMs, timeoutMs + 40_000]) {
        const budget = resolveStructuredWorkerPreambleBudgetMs({
          startedAtMs: 0,
          timeoutMs,
          nowMs: spentMs
        })
        expect(budget).toBeGreaterThanOrEqual(0)
        expect(budget).toBeLessThanOrEqual(ORCHESTRATION_READINESS_TIMEOUT_MS)
        expect(spentMs + budget).toBeLessThanOrEqual(
          Math.max(spentMs, timeoutMs + AGENT_PROMPT_EFFECT_TIMEOUT_MS)
        )
        expect(AGENT_PROMPT_EFFECT_TIMEOUT_MS).toBeLessThan(
          ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
        )
      }
    }
  })
})
