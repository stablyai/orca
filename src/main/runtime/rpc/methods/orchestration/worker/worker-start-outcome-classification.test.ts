import { describe, expect, it } from 'vitest'
import { isUnknownWorkerStartOutcome } from './worker-start-outcome-classification'
import {
  createWorkerAgentDiscoveryReceipt,
  createWorkerStartRecoveryCommand
} from '../../orchestration-worker-start'

describe('worker start outcome classification', () => {
  it('keeps OpenCode and OMP discovery identities and executables distinct', () => {
    expect(createWorkerAgentDiscoveryReceipt('opencode')).toEqual({
      requestedId: 'opencode',
      resolvedId: 'opencode',
      executable: 'opencode'
    })
    expect(createWorkerAgentDiscoveryReceipt('omp')).toEqual({
      requestedId: 'omp',
      resolvedId: 'omp',
      executable: 'omp'
    })
  })

  it('emits one exact retry or replacement recovery command', () => {
    const base = {
      executable: 'orca-ide',
      taskId: 'task-1',
      dispatchId: 'dispatch-1',
      attemptId: 'attempt-1',
      terminalHandle: 'term-1'
    }

    expect(createWorkerStartRecoveryCommand({ ...base, exactRetryAvailable: true })).toBe(
      'orca-ide orchestration worker-start --task task-1 --terminal term-1 --attempt-id attempt-1 --retry-of dispatch-1 --json'
    )
    expect(createWorkerStartRecoveryCommand({ ...base, exactRetryAvailable: false })).toBe(
      'orca-ide orchestration replace-worker --task task-1 --predecessor dispatch-1 --json'
    )
  })

  it('treats an explicit operation_unknown code as unknown at any stage', () => {
    const error = Object.assign(new Error('relay dropped'), { code: 'operation_unknown' })

    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
    expect(isUnknownWorkerStartOutcome(error, 'worktree_create')).toBe(true)
  })

  it('treats a lost connection during worktree create as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'worktree_create')).toBe(true)
    expect(isUnknownWorkerStartOutcome(new Error('request timed out'), 'worktree_create')).toBe(
      true
    )
  })

  it('keeps a definite failure definite', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'dispatch_input')).toBe(false)
    expect(isUnknownWorkerStartOutcome(new Error('worktree exists'), 'worktree_create')).toBe(false)
  })

  // Why: a stalled prompt still reports a definite failure to the caller — the correction path is
  // the worker's own report, which keeps its capability and can re-settle the dispatch (see
  // worker-start-unobserved-prompt-settlement.test.ts), not an outcome_unknown receipt.
  it('does not class a stalled dispatch prompt as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('agent_prompt_stalled'), 'dispatch_input')).toBe(
      false
    )
  })
})
