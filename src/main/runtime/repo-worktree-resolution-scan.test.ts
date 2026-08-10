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

    await expect(scanLocalRepoWorktreesForResolution('/repo', {}, 3)).resolves.toEqual({
      ok: false,
      worktrees: []
    })
  })

  it('preserves a successful empty scan verdict', async () => {
    vi.mocked(listWorktreesStrict).mockResolvedValue([])

    await expect(
      scanLocalRepoWorktreesForResolution('/repo', { wslDistro: 'Ubuntu' }, 3)
    ).resolves.toEqual({ ok: true, worktrees: [], lineageRevision: 3 })
    expect(listWorktreesStrict).toHaveBeenCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })

  it('retains the causal revision supplied before the listing runs', async () => {
    let liveRevision = 12
    vi.mocked(listWorktreesStrict).mockImplementation(async () => {
      liveRevision += 1
      return []
    })

    const result = await scanLocalRepoWorktreesForResolution('/repo', {}, liveRevision)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lineageRevision).toBe(12)
      expect(liveRevision).toBe(13)
    }
  })
})
