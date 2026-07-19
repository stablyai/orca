import { describe, expect, it, vi } from 'vitest'
import { getRepoSelectorFromWorktreeSelector, resolveRepoSelectorFlag } from './selectors'

describe('repo selectors', () => {
  it('extracts the repo from an explicit worktree id', () => {
    expect(getRepoSelectorFromWorktreeSelector('id:repo-a::/worktree')).toBe('id:repo-a')
  })

  it('passes explicit repo selectors through unchanged', async () => {
    const client = { isRemote: false, call: vi.fn() }
    await expect(
      resolveRepoSelectorFlag(new Map([['repo', 'name:repo-a']]), '/cwd', client as never)
    ).resolves.toBe('name:repo-a')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('resolves active to the enclosing worktree repo', async () => {
    const client = {
      isRemote: false,
      call: vi.fn().mockResolvedValue({
        result: { worktrees: [{ id: 'repo-a::/worktree', path: '/worktree' }] }
      })
    }
    await expect(
      resolveRepoSelectorFlag(new Map([['repo', 'active']]), '/worktree/src', client as never)
    ).resolves.toBe('id:repo-a')
  })
})
