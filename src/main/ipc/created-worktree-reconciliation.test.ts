import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeCreatedWorktree, listWorktreesSharedStrict } from '../git/worktree'
import { findCreatedWorktree, resolveCreatedWorktree } from './created-worktree-reconciliation'

vi.mock('../git/worktree', () => ({
  listWorktreesSharedStrict: vi.fn(),
  describeCreatedWorktree: vi.fn()
}))

const CREATED = {
  path: '/workspaces/feature',
  head: 'abc123',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}
const MAIN = { ...CREATED, path: '/repo', branch: 'refs/heads/main', isMainWorktree: true }

describe('findCreatedWorktree', () => {
  it('prefers the direct path match', () => {
    const direct = { path: '/home/user/worktrees/feature', branch: 'refs/heads/other' }
    const branch = { path: '/var/home/user/worktrees/feature', branch: 'refs/heads/feature' }

    expect(
      findCreatedWorktree([direct, branch], '/home/user/worktrees/feature', 'feature', 'linux')
    ).toBe(direct)
  })

  it('matches the exact Git-listed branch when the requested path is an alias', () => {
    const created = {
      path: '/var/home/user/worktrees/feature',
      branch: 'refs/heads/user/feature'
    }

    expect(
      findCreatedWorktree(
        [{ path: '/stale/worktree', branch: 'refs/heads/stale' }, created],
        '/home/user/worktrees/feature',
        'user/feature',
        'linux'
      )
    ).toBe(created)
  })

  it('does not accept a branch suffix collision', () => {
    const suffixCollision = {
      path: '/worktrees/prefix-feature',
      branch: 'refs/heads/prefix/feature'
    }

    expect(
      findCreatedWorktree([suffixCollision], '/different/worktrees/feature', 'feature', 'linux')
    ).toBeUndefined()
  })

  it('keeps Windows drive, slash, and case normalization on the direct path', () => {
    const created = {
      path: String.raw`C:\Users\Orca\feature`,
      branch: 'refs/heads/other'
    }

    expect(findCreatedWorktree([created], 'c:/users/orca/feature', 'feature', 'win32')).toBe(
      created
    )
  })

  it.each([
    ['relative POSIX paths', 'worktrees/feature', './worktrees/feature', 'linux' as const],
    [
      'macOS /private/tmp alias',
      '/private/tmp/worktrees/feature',
      '/tmp/worktrees/feature',
      'darwin' as const
    ]
  ])('keeps %s on the direct path', (_case, listed, requested, os) => {
    const created = { path: listed, branch: 'refs/heads/other' }

    expect(findCreatedWorktree([created], requested, 'feature', os)).toBe(created)
  })

  it('keeps non-Windows POSIX path comparison case-sensitive', () => {
    const listed = { path: '/worktrees/Feature', branch: 'refs/heads/other' }

    expect(findCreatedWorktree([listed], '/worktrees/feature', 'feature', 'linux')).toBeUndefined()
  })

  it.each([
    ['WSL', '/home/user/worktrees/feature', '/var/home/user/worktrees/feature', 'win32' as const],
    ['SSH', '/srv/link/feature', '/srv/canonical/feature', 'linux' as const]
  ])(
    'uses Git branch identity without host path resolution for %s',
    (_host, requested, listed, os) => {
      const created = { path: listed, branch: 'refs/heads/feature' }

      expect(findCreatedWorktree([created], requested, 'feature', os)).toBe(created)
    }
  )
})

describe('resolveCreatedWorktree', () => {
  beforeEach(() => {
    vi.mocked(listWorktreesSharedStrict).mockReset()
    vi.mocked(describeCreatedWorktree).mockReset().mockResolvedValue(undefined)
  })

  it('reports the whole listing when it contains the created row', async () => {
    vi.mocked(listWorktreesSharedStrict).mockResolvedValue([MAIN, CREATED])

    await expect(
      resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')
    ).resolves.toEqual({ created: CREATED, worktrees: [MAIN, CREATED], listingComplete: true })
    expect(describeCreatedWorktree).not.toHaveBeenCalled()
  })

  it('completes the create from the direct read when the listing fails', async () => {
    vi.mocked(listWorktreesSharedStrict).mockRejectedValue(new Error('git timed out.'))
    vi.mocked(describeCreatedWorktree).mockResolvedValue(CREATED)

    await expect(
      resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')
    ).resolves.toEqual({ created: CREATED, worktrees: [], listingComplete: false })
  })

  it('completes the create from the direct read when the listing omits the row', async () => {
    vi.mocked(listWorktreesSharedStrict).mockResolvedValue([MAIN])
    vi.mocked(describeCreatedWorktree).mockResolvedValue(CREATED)

    await expect(
      resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')
    ).resolves.toMatchObject({ created: CREATED, listingComplete: false })
  })

  it("surfaces the listing's own failure rather than an opaque message", async () => {
    const failure = new Error('fatal: not a git repository')
    vi.mocked(listWorktreesSharedStrict).mockRejectedValue(failure)

    await expect(resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')).rejects.toBe(
      failure
    )
  })

  it('keeps the listing failure when the direct read itself throws', async () => {
    const failure = new Error('fatal: not a git repository')
    vi.mocked(listWorktreesSharedStrict).mockRejectedValue(failure)
    vi.mocked(describeCreatedWorktree).mockRejectedValue(new Error('rev-parse exploded'))

    await expect(resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')).rejects.toBe(
      failure
    )
  })

  it('names the path and branch when the listing succeeded without the row', async () => {
    vi.mocked(listWorktreesSharedStrict).mockResolvedValue([MAIN])

    await expect(resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')).rejects.toThrow(
      'Worktree created but not found in listing: /workspaces/feature (branch feature)'
    )
  })

  it("adds the direct read's failure when the listing merely omitted the row", async () => {
    vi.mocked(listWorktreesSharedStrict).mockResolvedValue([MAIN])
    vi.mocked(describeCreatedWorktree).mockRejectedValue(new Error('rev-parse exploded'))

    await expect(resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')).rejects.toThrow(
      'Worktree created but not found in listing: /workspaces/feature (branch feature): rev-parse exploded'
    )
  })

  it('charges the recovery what the listing left of the budget, not a fresh one', async () => {
    vi.mocked(listWorktreesSharedStrict).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      throw new Error('git worktree list timed out.')
    })
    vi.mocked(describeCreatedWorktree).mockResolvedValue(CREATED)

    await resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')

    const options = vi.mocked(describeCreatedWorktree).mock.lastCall?.[3]
    expect(options?.timeout).toBeGreaterThanOrEqual(5_000)
    expect(options?.timeout).toBeLessThan(30_000)
  })

  it("keeps the caller's own deadline instead of the shared budget", async () => {
    vi.mocked(listWorktreesSharedStrict).mockRejectedValue(new Error('git worktree list failed.'))
    vi.mocked(describeCreatedWorktree).mockResolvedValue(CREATED)

    await resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature', { timeout: 1_234 })

    expect(vi.mocked(describeCreatedWorktree).mock.lastCall?.[3]).toMatchObject({ timeout: 1_234 })
  })

  it('forwards exec options only when the caller supplied them', async () => {
    vi.mocked(listWorktreesSharedStrict).mockResolvedValue([CREATED])
    await resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature')
    expect(listWorktreesSharedStrict).toHaveBeenLastCalledWith('/repo')

    await resolveCreatedWorktree('/repo', '/workspaces/feature', 'feature', { wslDistro: 'Ubuntu' })
    expect(listWorktreesSharedStrict).toHaveBeenLastCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })
})
