import { describe, expect, it } from 'vitest'
import {
  prepareFederationAttachmentWorkerStart,
  resolveBoundedWorkerControls,
  resolveWorkerDeadlineAt
} from './orchestration-worker-start-validation'

const budget = {
  dispatchGroup: 'leaf-workers',
  dispatchIndex: 1,
  maxDispatches: 1,
  maxRuntimeMs: 60_000,
  maxRequests: 10,
  maxReviewCycles: 0
}

describe('bounded worker leaf validation', () => {
  it.each(['pi', 'omp', 'kimi'] as const)(
    'rejects %s because it has no hard fan-out disable',
    (agent) => {
      expect(() => resolveBoundedWorkerControls(budget, agent)).toThrow(
        'does not expose a hard fan-out disable'
      )
    }
  )

  it.each(['claude', 'codex'] as const)('accepts %s with CLI leaf enforcement', (agent) => {
    expect(resolveBoundedWorkerControls(budget, agent).leafControl).toEqual({
      leaf: true,
      provider: agent,
      enforcement: 'environment_and_cli'
    })
  })

  it('reuses the prior absolute deadline for a retry', () => {
    expect(
      resolveWorkerDeadlineAt({
        db: {
          getWorkerDispatch: () => ({ deadline_at: '2026-08-15T00:00:10.000Z' }) as never
        },
        retryOf: 'ctx_prior',
        maxRuntimeMs: 7_200_000,
        now: () => Date.parse('2026-08-15T00:00:09.000Z')
      })
    ).toBe('2026-08-15T00:00:10.000Z')
  })

  it('rejects supervised terminal reuse at the worker-server attachment boundary', () => {
    expect(() =>
      prepareFederationAttachmentWorkerStart({
        params: { terminal: 'term_existing' } as never,
        createsWorktree: false,
        runtime: {} as never
      })
    ).toThrow('always creates a fresh bounded process')
  })
})
