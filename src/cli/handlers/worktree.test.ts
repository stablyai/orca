import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { WORKTREE_HANDLERS } from './worktree'

describe('worktree ps handler', () => {
  it('resolves and forwards the active repo scope', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: { worktrees: [{ id: 'repo-a::/worktree', path: '/worktree' }] }
      })
      .mockResolvedValueOnce({ result: { worktrees: [], totalCount: 0, truncated: false } })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await WORKTREE_HANDLERS['worktree ps']({
      flags: new Map([['repo', 'active']]),
      client: { isRemote: false, call } as unknown as RuntimeClient,
      cwd: '/worktree/src',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(call).toHaveBeenNthCalledWith(2, 'worktree.ps', {
      repo: 'id:repo-a',
      limit: undefined
    })
  })
})
