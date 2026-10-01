import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesFromMembershipStrict } from '../git/worktree'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'

vi.mock('../git/worktree', () => ({ listWorktreesFromMembershipStrict: vi.fn() }))

describe('scanLocalRepoWorktreesForResolution', () => {
  beforeEach(() => {
    vi.mocked(listWorktreesFromMembershipStrict).mockReset()
  })

  it('degrades a local Git execution failure instead of reporting an empty success', async () => {
    vi.mocked(listWorktreesFromMembershipStrict).mockRejectedValue(
      Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })
    )

    await expect(scanLocalRepoWorktreesForResolution('/repo', {})).resolves.toEqual({
      ok: false,
      worktrees: []
    })
  })

  it('preserves a successful empty scan verdict', async () => {
    vi.mocked(listWorktreesFromMembershipStrict).mockResolvedValue([])

    await expect(
      scanLocalRepoWorktreesForResolution('/repo', { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ ok: true, worktrees: [] })
    expect(listWorktreesFromMembershipStrict).toHaveBeenCalledWith('/repo', {
      wslDistro: 'Ubuntu',
      waitMs: RESOLVED_WORKTREE_REPO_TIMEOUT_MS
    })
  })
})
