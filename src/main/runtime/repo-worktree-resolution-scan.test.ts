import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesStrict } from '../git/worktree'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'

vi.mock('../git/worktree', () => ({ listWorktreesStrict: vi.fn() }))

describe('scanLocalRepoWorktreesForResolution', () => {
  beforeEach(() => {
    vi.mocked(listWorktreesStrict).mockReset()
  })

  it('degrades a local Git execution failure instead of reporting an empty success', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(
      Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })
    )

    await expect(scanLocalRepoWorktreesForResolution('/repo', {})).resolves.toEqual({
      ok: false,
      worktrees: []
    })
  })

  it('preserves a successful empty scan verdict', async () => {
    vi.mocked(listWorktreesStrict).mockResolvedValue([])

    await expect(
      scanLocalRepoWorktreesForResolution('/repo', { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ ok: true, worktrees: [] })
    expect(listWorktreesStrict).toHaveBeenCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })
})
