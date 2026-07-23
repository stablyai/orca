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
        resolveSymlinks: true,
        resolveRealPath
      })
    ).resolves.toEqual(listed[0])
    expect(resolveRealPath).toHaveBeenCalledWith('/home/user/ws/repo/feature')
    expect(resolveRealPath).toHaveBeenCalledWith('/var/home/user/ws/repo/feature')
  })

  it('requires explicit native-host authority before resolving realpaths', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) =>
      pathValue.replace(/^\/home\//, '/var/home/')
    )
    const listed = [{ path: '/var/home/user/ws/repo/feature' }]

    await expect(
      findListedWorktreeByPath(listed, '/home/user/ws/repo/feature', {
        platform: 'linux',
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
          resolveSymlinks: true,
          resolveRealPath
        }
      )
    ).resolves.toBeUndefined()
    expect(resolveRealPath).toHaveBeenCalledTimes(1)
  })

  it('continues after a stale listed row fails to resolve', async () => {
    const matching = { path: '/var/home/user/ws/repo/feature' }
    const resolveRealPath = vi.fn(async (pathValue: string) => {
      if (pathValue === '/stale/worktree') {
        throw new Error('ENOENT')
      }
      return pathValue.replace(/^\/home\//, '/var/home/')
    })

    await expect(
      findListedWorktreeByPath(
        [{ path: '/stale/worktree' }, matching],
        '/home/user/ws/repo/feature',
        { platform: 'linux', resolveSymlinks: true, resolveRealPath }
      )
    ).resolves.toBe(matching)
    expect(resolveRealPath).toHaveBeenCalledTimes(3)
  })

  it('bounds failed realpath probes to the request plus one per listed row', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) => {
      if (pathValue === '/home/user/ws/repo/feature') {
        return '/var/home/user/ws/repo/feature'
      }
      throw new Error(pathValue.includes('forbidden') ? 'EACCES' : 'ENOENT')
    })
    const listed = [{ path: '/broken/link' }, { path: '/forbidden/worktree' }]

    await expect(
      findListedWorktreeByPath(listed, '/home/user/ws/repo/feature', {
        platform: 'linux',
        resolveSymlinks: true,
        resolveRealPath
      })
    ).resolves.toBeUndefined()
    expect(resolveRealPath).toHaveBeenCalledTimes(listed.length + 1)
  })

  it('keeps Windows drive, slash, and case normalization on the direct fast path', async () => {
    const resolveRealPath = vi.fn(async (pathValue: string) => pathValue)
    const listed = [{ path: String.raw`C:\Users\Orca\feature` }]

    await expect(
      findListedWorktreeByPath(listed, 'c:/users/orca/feature', {
        platform: 'win32',
        resolveSymlinks: true,
        resolveRealPath
      })
    ).resolves.toBe(listed[0])
    expect(resolveRealPath).not.toHaveBeenCalled()
  })

  it.each([
    ['WSL', 'win32' as const],
    ['SSH', 'linux' as const]
  ])('does not use host realpath for %s POSIX paths', async (_host, platform) => {
    const resolveRealPath = vi.fn(async () => '/var/home/user/ws/repo/feature')

    await expect(
      findListedWorktreeByPath(
        [{ path: '/var/home/user/ws/repo/feature' }],
        '/home/user/ws/repo/feature',
        { platform, resolveRealPath }
      )
    ).resolves.toBeUndefined()
    expect(resolveRealPath).not.toHaveBeenCalled()
  })
})
