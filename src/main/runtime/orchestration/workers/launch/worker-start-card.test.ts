import { describe, expect, it } from 'vitest'
import { recordWorkerStartOutcome, type WorkerStarted } from './worker-start-card'

describe('recordWorkerStartOutcome', () => {
  it('records every failed start as a failure with a reason, and still skips a start in progress', () => {
    const recorded: WorkerStarted[] = []
    const started = {
      reusedTerminal: true,
      dispatchId: 'ctx_1',
      taskId: 'task_1',
      workerAddress: undefined,
      task: 'spec'
    }
    const record = (start: WorkerStarted): void => {
      recorded.push(start)
    }

    recordWorkerStartOutcome(
      record,
      { state: 'failed', lastError: 'Agent did not become ready.' },
      started
    )
    recordWorkerStartOutcome(record, { state: 'failed', lastError: '' }, started)
    recordWorkerStartOutcome(record, { state: 'starting' }, started)

    expect(recorded).toEqual([
      {
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        task: 'spec',
        workerAddress: 'dispatch:ctx_1',
        ready: false,
        failure: 'Agent did not become ready.'
      },
      {
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        task: 'spec',
        workerAddress: 'dispatch:ctx_1',
        ready: false,
        failure: 'The start failed.'
      }
    ])
  })
})
