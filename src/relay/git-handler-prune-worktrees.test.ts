import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

type GitSpyTarget = {
  git(
    args: string[],
    cwd: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>
}

describe('relay worktree prune', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  afterEach(() => {
    handler.dispose()
  })

  it('forwards request cancellation to the Git subprocess', async () => {
    const controller = new AbortController()
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockResolvedValue({ stdout: '', stderr: '' })

    await dispatcher.callRequest(
      'git.pruneWorktrees',
      { repoPath: '/repo' },
      { isStale: () => false, signal: controller.signal }
    )

    expect(gitSpy).toHaveBeenCalledWith(['worktree', 'prune'], '/repo', {
      signal: controller.signal
    })
  })
})
