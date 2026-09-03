import { describe, expect, it } from 'vitest'
import { buildOrchestrationPromptMarker } from '../../shared/orchestration-prompt-marker'
import { resolveOrchestrationPromptDeliveryEvidence } from './orchestration-prompt-delivery-evidence'

const marker = buildOrchestrationPromptMarker('task_exact', 'dispatch_exact')
const baseline = {
  taskId: 'task_exact',
  dispatchId: 'dispatch_exact',
  expectedProcessIncarnation: 'runtime:terminal:1',
  currentProcessIncarnation: 'runtime:terminal:1',
  submittedAt: 100,
  terminalOutputAt: 110,
  terminalStatus: 'working',
  waitText: marker,
  hooks: []
}

describe('resolveOrchestrationPromptDeliveryEvidence', () => {
  it('accepts an exact post-submit rendered marker', () => {
    expect(resolveOrchestrationPromptDeliveryEvidence(baseline)).toBe('input_delivered')
  })

  it.each([
    ['wrong dispatch', buildOrchestrationPromptMarker('task_exact', 'dispatch_old'), 110],
    ['stale render', marker, 99]
  ])('rejects %s evidence', (_label, waitText, terminalOutputAt) => {
    expect(
      resolveOrchestrationPromptDeliveryEvidence({ ...baseline, waitText, terminalOutputAt })
    ).toBeNull()
  })

  it('rejects exact evidence from a replaced terminal incarnation', () => {
    expect(
      resolveOrchestrationPromptDeliveryEvidence({
        ...baseline,
        currentProcessIncarnation: 'runtime:terminal:2'
      })
    ).toBeNull()
  })

  it('keeps exact activity authoritative when a concurrent SessionStart has no prompt', () => {
    expect(
      resolveOrchestrationPromptDeliveryEvidence({
        ...baseline,
        waitText: '',
        hooks: [
          { prompt: '', state: 'done', receivedAt: 120 },
          { prompt: marker, state: 'working', receivedAt: 110 }
        ]
      })
    ).toBe('worker_running')
  })
})
