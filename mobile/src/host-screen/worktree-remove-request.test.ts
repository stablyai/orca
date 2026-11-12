import { describe, expect, it } from 'vitest'
import { worktreeRemovalReplyTimeoutMs } from '../../../src/shared/worktree/archive-hook-removal-gate'
import { RECIPE_REMOVAL_REPLY_TIMEOUT_MS } from '../../../src/shared/recipe-host-removal'
import { buildWorktreeRemoveRequest } from './worktree-remove-request'

describe('phone worktree delete request', () => {
  it('keeps the ordinary delete for workspaces the desktop did not tag', () => {
    expect(buildWorktreeRemoveRequest({ worktreeId: 'r::/w' }, { runHooks: false })).toEqual({
      params: { worktree: 'id:r::/w', force: true, runHooks: false },
      timeoutMs: worktreeRemovalReplyTimeoutMs(false)
    })
  })

  it('asks for the named recipe environment to be destroyed, and waits for its destroy step', () => {
    const request = buildWorktreeRemoveRequest(
      { worktreeId: 'r::/w', recipeEnvironment: { name: 'task' } },
      { runHooks: true }
    )
    expect(request.params).toEqual({
      worktree: 'id:r::/w',
      force: true,
      runHooks: true,
      destroyHost: true
    })
    expect(request.timeoutMs).toBe(RECIPE_REMOVAL_REPLY_TIMEOUT_MS)
  })
})
