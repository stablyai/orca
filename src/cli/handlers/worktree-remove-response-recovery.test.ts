import { describe, expect, it } from 'vitest'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { addWorktreeRemoveResponseRecovery } from './worktree-remove-response-recovery'

describe('worktree remove response recovery', () => {
  it.each([
    new RuntimeClientError('runtime_unavailable', 'Connection closed.', {
      requestPhase: 'awaiting_response',
      method: 'worktree.rm'
    }),
    new RuntimeClientError(
      'runtime_unavailable',
      'The Orca runtime closed the connection before responding. Restart Orca and try again.',
      { requestPhase: 'awaiting_response', method: 'worktree.rm' }
    ),
    new RuntimeClientError(
      'runtime_unavailable',
      'The Orca runtime changed while the request was in flight. Retry the command.',
      { requestPhase: 'awaiting_response', method: 'worktree.rm' }
    ),
    new RuntimeRpcFailureError({
      id: 'slow-rm',
      ok: false,
      error: {
        code: 'runtime_timeout',
        message: 'Bounded liveness expired.',
        data: { requestPhase: 'awaiting_response', method: 'worktree.rm' }
      }
    })
  ])('warns that a sent removal may still complete', (error) => {
    const recovered = addWorktreeRemoveResponseRecovery(error)

    expect(recovered).toBeInstanceOf(error.constructor)
    expect(recovered).toMatchObject({
      data: {
        mutationMayHaveCompleted: true,
        nextSteps: expect.arrayContaining([expect.stringContaining('worktree list --json')])
      }
    })
    expect((recovered as Error).message).toContain('may still complete')
    expect((recovered as Error).message).not.toMatch(/Restart Orca and try again|Retry the command/)
  })

  it.each([
    { requestPhase: 'not_sent', method: 'worktree.rm' },
    { requestPhase: 'awaiting_response', method: 'status.get' },
    undefined
  ])('does not add destructive ambiguity before dispatch acceptance', (data) => {
    const error = new RuntimeClientError('runtime_unavailable', 'Connection failed.', data)

    expect(addWorktreeRemoveResponseRecovery(error)).toBe(error)
  })
})
