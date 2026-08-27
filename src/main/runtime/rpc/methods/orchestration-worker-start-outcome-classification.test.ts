import { describe, expect, it } from 'vitest'
import { isUnknownWorkerStartOutcome } from './orchestration-worker-topology'

describe('worker start outcome classification', () => {
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

  // Enter was already written, so a missing turn-start observation cannot prove failure.
  it('classes a stalled dispatch prompt as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('agent_prompt_stalled'), 'dispatch_input')).toBe(
      true
    )
  })
})
