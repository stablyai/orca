import { describe, expect, it, vi } from 'vitest'
import { deleteRemoteWorktreeHistory } from './remote-worktree-history-cleanup'

describe('deleteRemoteWorktreeHistory', () => {
  it('repeats idempotent cleanup through the PTY owner', async () => {
    const deleteWorktreeHistory = vi.fn().mockResolvedValue(undefined)
    const provider = { deleteWorktreeHistory } as never

    await deleteRemoteWorktreeHistory(provider, 'repo-1::/remote/wt')
    await deleteRemoteWorktreeHistory(provider, 'repo-1::/remote/wt')

    expect(deleteWorktreeHistory).toHaveBeenCalledTimes(2)
  })

  it('degrades safely when an old relay does not expose cleanup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = {
      deleteWorktreeHistory: vi.fn().mockRejectedValue(new Error('unknown request method'))
    } as never

    try {
      await expect(
        deleteRemoteWorktreeHistory(provider, 'repo-1::/remote/wt')
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Remote cleanup unavailable'))
    } finally {
      warn.mockRestore()
    }
  })
})
