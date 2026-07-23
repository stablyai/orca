import { describe, expect, it, vi } from 'vitest'
import { findListedWorktreeByPath } from './worktree-path-comparison'

describe('findListedWorktreeByPath', () => {
  it('matches by normalized path without realpath when strings already equal', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) => pathValue)
    const listed = [{ path: '/home/user/ws/repo/feature' }]

    await expect(
      findListedWorktreeByPath(listed, '/home/user/ws/repo/feature', {
        platform: 'linux',
        resolveRealPath
      })
    ).resolves.toEqual(listed[0])
    expect(resolveRealPath).not.toHaveBeenCalled()
  })

  it('matches symlink workspace roots via realpath (immutable Linux /home → /var/home)', async () => {
    // Why: git worktree list reports the canonical path while Orca may request
    // the user-facing /home path that is a symlink to /var/home.
    const resolveRealPath = vi.fn(async (pathValue: string) =>
      pathValue.replace(/^\/home\//, '/var/home/')
    )
    const listed = [{ path: '/var/home/user/ws/repo/feature', branch: 'refs/heads/feature' }]

    await expect(
      findListedWorktreeByPath(listed, '/home/user/ws/repo/feature', {
        platform: 'linux',
        resolveRealPath
      })
    ).resolves.toEqual(listed[0])
    expect(resolveRealPath).toHaveBeenCalledWith('/home/user/ws/repo/feature')
    expect(resolveRealPath).toHaveBeenCalledWith('/var/home/user/ws/repo/feature')
  })

  it('skips realpath when resolveSymlinks is false (WSL/SSH listings)', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) =>
      pathValue.replace(/^\/home\//, '/var/home/')
    )
    const listed = [{ path: '/var/home/user/ws/repo/feature' }]

    await expect(
      findListedWorktreeByPath(listed, '/home/user/ws/repo/feature', {
        platform: 'linux',
        resolveSymlinks: false,
        resolveRealPath
      })
    ).resolves.toBeUndefined()
    expect(resolveRealPath).not.toHaveBeenCalled()
  })

  it('returns undefined when realpath cannot resolve the requested path', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) => {
      if (pathValue.startsWith('/home/')) {
        throw new Error('ENOENT')
      }
      return pathValue
    })

    await expect(
      findListedWorktreeByPath(
        [{ path: '/var/home/user/ws/repo/feature' }],
        '/home/user/ws/repo/feature',
        {
          platform: 'linux',
          resolveRealPath
        }
      )
    ).resolves.toBeUndefined()
  })
})
