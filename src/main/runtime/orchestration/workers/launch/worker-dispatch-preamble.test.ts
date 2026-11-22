import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './worker-dispatch-preamble'

describe('buildDispatchPreamble', () => {
  it('names only the worker terminal handle, not the coordinator one (#14570)', () => {
    const text = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'disp_1',
      taskSpec: 'do the task',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker'
    })
    expect(text).toContain('orchestration ask --from term_worker')
    expect(text).not.toContain('term_coordinator')
  })
})
