import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

describe('orchestration worker start validation', () => {
  it('rejects combining an explicit terminal with a ZCode startup agent', () => {
    expect(() =>
      prepareLocalWorkerStart({
        params: {
          task: 'task-1',
          from: 'term-coordinator',
          terminal: 'term-worker',
          agent: 'zcode'
        } as WorkerStartInput,
        createsWorktree: false,
        runtime: {} as OrcaRuntimeService
      })
    ).toThrow('--terminal reuses an existing agent and cannot combine with --agent.')
  })
})
