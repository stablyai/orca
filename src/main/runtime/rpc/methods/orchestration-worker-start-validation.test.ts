import { describe, expect, it } from 'vitest'
import { resolveBoundedWorkerControls } from './orchestration-worker-start-validation'

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
})
