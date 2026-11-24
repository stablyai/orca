import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './worker-dispatch-preamble'

const base = {
  taskId: 'task_1',
  dispatchId: 'dispatch_1',
  taskSpec: 'work',
  coordinatorHandle: 'term_coordinator',
  workerHandle: 'term_worker'
}

describe('buildDispatchPreamble', () => {
  it('carries bot commit-credit rules without adding them to other workers', () => {
    const botWorker = buildDispatchPreamble({ ...base, preserveHumanCommitCredit: true })
    const otherWorker = buildDispatchPreamble(base)

    expect(botWorker).toContain('do not add AI/model co-author or generated-by trailers')
    expect(botWorker).toContain('genuine human contributor whose work you carry')
    expect(otherWorker).not.toContain('AI/model co-author')
  })
})
