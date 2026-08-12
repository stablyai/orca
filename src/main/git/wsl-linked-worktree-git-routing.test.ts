import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseWindowsLinkedGitdir,
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests,
  usesHostGitForWslLinkedWorktree,
  WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD,
  WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_PER_CWD,
  WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL,
  WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS,
  WSL_LINKED_WORKTREE_ROUTE_RETRY_BASE_MS,
  WSL_LINKED_WORKTREE_ROUTE_TTL_MS,
  type WslLinkedWorktreeRoutingFileSystem
} from './wsl-linked-worktree-git-routing'

afterEach(() => resetWslLinkedWorktreeGitRoutingForTests())

const fileMarker = { isDirectory: () => false, isFile: () => true }
const directoryMarker = { isDirectory: () => true, isFile: () => false }

function missingMarker(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

describe('parseWindowsLinkedGitdir', () => {
  it.each([
    ['gitdir: C:/repo/.git/worktrees/linked\n', 'C:/repo/.git/worktrees/linked'],
    [String.raw`gitdir: D:\repo\.git\worktrees\linked`, String.raw`D:\repo\.git\worktrees\linked`]
  ])('accepts a Windows drive-qualified gitdir', (content, expected) => {
    expect(parseWindowsLinkedGitdir(content)).toBe(expected)
  })

  it.each([
    'gitdir: ../main/.git/worktrees/linked',
    'gitdir: /home/dev/repo/.git/worktrees/linked',
    'gitdir: C:repo/.git/worktrees/linked',
    'not a gitdir'
  ])('rejects the non-Windows-linked marker %s', (content) => {
    expect(parseWindowsLinkedGitdir(content)).toBeNull()
  })
})

describe('usesHostGitForWslLinkedWorktree', () => {
  it('scopes a cached route to the exact primed folder workspace', () => {
    seedWslLinkedWorktreeGitRoutingForTests(String.raw`C:\repo\linked\packages\app`)

    expect(
      usesHostGitForWslLinkedWorktree(String.raw`C:\repo\linked\packages\app`, 'Ubuntu', 'win32')
    ).toBe(true)
    expect(usesHostGitForWslLinkedWorktree('C:/repo/linked/packages/app/', 'Ubuntu', 'win32')).toBe(
      true
    )
    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo\main`, 'Ubuntu', 'win32')).toBe(false)
  })

  it('does not affect native Windows, WSL-native, or non-Windows execution', () => {
    seedWslLinkedWorktreeGitRoutingForTests(String.raw`C:\repo\linked`)

    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo\linked`, undefined, 'win32')).toBe(
      false
    )
    expect(
      usesHostGitForWslLinkedWorktree(
        '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        'Ubuntu',
        'win32'
      )
    ).toBe(false)
    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo\linked`, 'Ubuntu', 'linux')).toBe(
      false
    )
  })
})

describe('prepareWslLinkedWorktreeGitRouting', () => {
  it('discovers parent markers independently for sibling folder workspaces', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async (path) => {
        if (path === String.raw`C:\repo\.git`) {
          return fileMarker
        }
        throw missingMarker()
      }),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\packages\app`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\packages\other`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(6)
    expect(fileSystem.readFile).toHaveBeenCalledTimes(2)
  })

  it('caches an ordinary repository marker without reading it', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => directoryMarker),
      readFile: vi.fn(async () => '')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)
    expect(fileSystem.readFile).not.toHaveBeenCalled()
  })

  it('fails closed without caching a marker read error', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => fileMarker),
      readFile: vi
        .fn<WslLinkedWorktreeRoutingFileSystem['readFile']>()
        .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
        .mockResolvedValueOnce('gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
    expect(fileSystem.readFile).toHaveBeenCalledTimes(2)
  })

  it('backs off repeated marker stat errors after one immediate retry', async () => {
    let currentTime = 1_000
    const now = (): number => currentTime
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => {
        throw Object.assign(new Error('device unavailable'), { code: 'EIO' })
      }),
      readFile: vi.fn(async () => '')
    }
    const prepare = (): Promise<boolean> =>
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })

    await expect(prepare()).resolves.toBe(false)
    await expect(prepare()).resolves.toBe(false)
    await expect(prepare()).resolves.toBe(false)
    currentTime += WSL_LINKED_WORKTREE_ROUTE_RETRY_BASE_MS - 1
    await expect(prepare()).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)

    currentTime += 1
    await expect(prepare()).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(3)
  })

  it('does not inherit a linked-parent route across a nested repository boundary', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async (path) =>
        path === String.raw`C:\repo\linked\nested\.git` ? directoryMarker : fileMarker
      ),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\linked`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\linked\nested`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    expect(
      usesHostGitForWslLinkedWorktree(String.raw`C:\repo\linked\nested`, 'Ubuntu', 'win32')
    ).toBe(false)
  })

  it('does not conflate case-distinct directories on case-sensitive Windows storage', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async (path) =>
        path === String.raw`C:\Repo\.git` ? fileMarker : directoryMarker
      ),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\Repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
  })

  it('revalidates a linked route that becomes an ordinary repository', async () => {
    let linked = true
    let currentTime = 1_000
    const now = (): number => currentTime
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => (linked ? fileMarker : directoryMarker)),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(true)
    linked = false
    currentTime += WSL_LINKED_WORKTREE_ROUTE_TTL_MS - 1
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)

    currentTime += 1
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(false)
    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo`, 'Ubuntu', 'win32', now)).toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
    expect(fileSystem.readFile).toHaveBeenCalledTimes(1)
  })

  it('revalidates an ordinary repository that becomes a linked worktree', async () => {
    let linked = false
    let currentTime = 1_000
    const now = (): number => currentTime
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => (linked ? fileMarker : directoryMarker)),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(false)
    linked = true
    currentTime += WSL_LINKED_WORKTREE_ROUTE_TTL_MS - 1
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)

    currentTime += 1
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(true)
    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo`, 'Ubuntu', 'win32', now)).toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
    expect(fileSystem.readFile).toHaveBeenCalledTimes(1)
  })

  it('does not let a sibling route supersede an unexpired nested-repository miss', async () => {
    let linked = false
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async (path) => {
        if (path === String.raw`C:\repo\.git`) {
          return linked ? fileMarker : directoryMarker
        }
        throw missingMarker()
      }),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\packages\app`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    linked = true
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\packages\other`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo\packages\app`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(6)
  })

  it('does not evict fresh routes while pruning under working-directory churn', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => fileMarker),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    for (let index = 0; index <= WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD; index += 1) {
      await prepareWslLinkedWorktreeGitRouting(`C:\\repo-${index}`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    }

    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo-0`, 'Ubuntu', 'win32')).toBe(true)
    expect(
      usesHostGitForWslLinkedWorktree(
        `C:\\repo-${WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD}`,
        'Ubuntu',
        'win32'
      )
    ).toBe(true)
  })

  it('coalesces delayed discovery without blocking an event-loop turn', async () => {
    let releaseStat: ((marker: typeof fileMarker) => void) | undefined
    const delayedStat = new Promise<typeof fileMarker>((resolve) => {
      releaseStat = resolve
    })
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(() => delayedStat),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }
    let settled = false

    const first = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem
    }).finally(() => {
      settled = true
    })
    const second = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(settled).toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)
    releaseStat?.(fileMarker)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(fileSystem.readFile).toHaveBeenCalledTimes(1)
  })

  it('cancels a waiter without canceling or duplicating shared discovery', async () => {
    let releaseStat: ((marker: typeof fileMarker) => void) | undefined
    const delayedStat = new Promise<typeof fileMarker>((resolve) => {
      releaseStat = resolve
    })
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(() => delayedStat),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }
    const controller = new AbortController()

    const cancelled = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem,
      signal: controller.signal
    })
    controller.abort()

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)
    releaseStat?.(fileMarker)
    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
    ).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)
  })

  it('ignores an old probe that settles after reset and a new same-path probe starts', async () => {
    let releaseOld: ((marker: typeof fileMarker) => void) | undefined
    const oldMarker = new Promise<typeof fileMarker>((resolve) => {
      releaseOld = resolve
    })
    const oldFileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(() => oldMarker),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }
    const oldRoute = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem: oldFileSystem
    })

    resetWslLinkedWorktreeGitRoutingForTests()
    let releaseCurrent: ((marker: typeof directoryMarker) => void) | undefined
    const currentMarker = new Promise<typeof directoryMarker>((resolve) => {
      releaseCurrent = resolve
    })
    const currentFileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(() => currentMarker),
      readFile: vi.fn(async () => '')
    }
    const currentRoute = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem: currentFileSystem
    })

    releaseOld?.(fileMarker)
    await expect(oldRoute).resolves.toBe(false)
    expect(usesHostGitForWslLinkedWorktree(String.raw`C:\repo`, 'Ubuntu', 'win32')).toBe(false)
    const currentJoiner = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem: currentFileSystem
    })
    expect(currentFileSystem.stat).toHaveBeenCalledTimes(1)

    releaseCurrent?.(directoryMarker)
    await expect(Promise.all([currentRoute, currentJoiner])).resolves.toEqual([false, false])
    expect(currentFileSystem.stat).toHaveBeenCalledTimes(1)
  })

  it('fails closed and retries after a stalled discovery deadline', async () => {
    vi.useFakeTimers()
    try {
      const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
        stat: vi
          .fn<WslLinkedWorktreeRoutingFileSystem['stat']>()
          .mockImplementationOnce(() => new Promise<typeof fileMarker>(() => {}))
          .mockResolvedValueOnce(fileMarker),
        readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
      }

      const first = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
      const second = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem
      })
      await vi.advanceTimersByTimeAsync(WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS)

      await expect(Promise.all([first, second])).resolves.toEqual([false, false])
      expect(fileSystem.stat).toHaveBeenCalledTimes(1)
      await expect(
        prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
          platform: 'win32',
          fileSystem
        })
      ).resolves.toBe(true)
      expect(fileSystem.stat).toHaveBeenCalledTimes(2)
      expect(fileSystem.readFile).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps outstanding probes for one working directory after repeated deadlines', async () => {
    vi.useFakeTimers()
    try {
      const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
        stat: vi.fn(() => new Promise<typeof fileMarker>(() => {})),
        readFile: vi.fn(async () => '')
      }
      const prepare = (): Promise<boolean> =>
        prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
          platform: 'win32',
          fileSystem
        })

      for (let index = 0; index < WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_PER_CWD; index += 1) {
        const route = prepare()
        await vi.advanceTimersByTimeAsync(WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS)
        await expect(route).resolves.toBe(false)
      }
      await vi.advanceTimersByTimeAsync(WSL_LINKED_WORKTREE_ROUTE_RETRY_BASE_MS)
      await expect(prepare()).resolves.toBe(false)
      expect(fileSystem.stat).toHaveBeenCalledTimes(WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_PER_CWD)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps outstanding probes across working directories', async () => {
    vi.useFakeTimers()
    try {
      const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
        stat: vi.fn(() => new Promise<typeof fileMarker>(() => {})),
        readFile: vi.fn(async () => '')
      }
      const pending = Array.from(
        { length: WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL },
        (_, index) =>
          prepareWslLinkedWorktreeGitRouting(`C:\\repo-${index}`, 'Ubuntu', {
            platform: 'win32',
            fileSystem
          })
      )

      await expect(
        prepareWslLinkedWorktreeGitRouting(String.raw`C:\blocked`, 'Ubuntu', {
          platform: 'win32',
          fileSystem
        })
      ).resolves.toBe(false)
      expect(fileSystem.stat).toHaveBeenCalledTimes(WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL)
      await vi.advanceTimersByTimeAsync(WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS)
      await expect(Promise.all(pending)).resolves.toEqual(
        Array.from({ length: WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL }, () => false)
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces concurrent revalidation after a cached route expires', async () => {
    let currentTime = 1_000
    const now = (): number => currentTime
    let releaseStat: ((marker: typeof fileMarker) => void) | undefined
    const delayedStat = new Promise<typeof fileMarker>((resolve) => {
      releaseStat = resolve
    })
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi
        .fn<WslLinkedWorktreeRoutingFileSystem['stat']>()
        .mockResolvedValueOnce(directoryMarker)
        .mockReturnValueOnce(delayedStat),
      readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
    }

    await expect(
      prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now
      })
    ).resolves.toBe(false)
    currentTime += WSL_LINKED_WORKTREE_ROUTE_TTL_MS

    const first = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem,
      now
    })
    const second = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, 'Ubuntu', {
      platform: 'win32',
      fileSystem,
      now
    })

    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
    releaseStat?.(fileMarker)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
    expect(fileSystem.readFile).toHaveBeenCalledTimes(1)
  })
})
