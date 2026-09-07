import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import {
  createGitCallReader,
  createGitCommandMocker,
  expectGitCallOrder,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { removeWorktree, WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './worktree'
import {
  __getSparseCheckoutStateCacheSizeForTests,
  detectSparseCheckoutCached
} from './worktree-sparse-checkout-cache'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
})

describe('removeWorktree', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('removes the worktree and deletes its local branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining(['git worktree remove /repo-feature', 'git branch -d -- feature/test'])
    )
    expect(calls).not.toContain('git worktree prune')
    expectGitCallOrder(calls, 'git worktree remove /repo-feature', 'git branch -d -- feature/test')
  })

  it('preserves the branch when requested for a pre-existing local branch checkout', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      }
    })

    await removeWorktree('/repo', '/repo-feature', false, { deleteBranch: false })

    const calls = getGitCalls()
    expect(calls).toContain('git worktree remove /repo-feature')
    expect(calls).not.toContain('git worktree prune')
    expect(calls).not.toContain('git branch -d -- feature/test')
    expect(calls).not.toContain('git branch -D -- feature/test')
  })

  it('skips branch deletion when another worktree still points at the branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-feature-copy
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature-copy
HEAD def456
branch refs/heads/feature/test
`
      },
      'git branch -d -- feature/test': {
        error: new Error(
          "cannot delete branch 'feature/test' used by worktree at '/repo-feature-copy'"
        )
      },
      'git branch -d -- feature/test#2': {
        error: new Error(
          "cannot delete branch 'feature/test' used by worktree at '/repo-feature-copy'"
        )
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git branch -d -- feature/test',
        'git worktree prune'
      ])
    )
    expect(calls.filter((call) => call === 'git branch -d -- feature/test')).toHaveLength(2)
    expect(calls).not.toContain('git branch -D -- feature/test')
  })

  it('deletes the branch after prune removes stale sibling worktree entries', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-stale
HEAD 0000000
branch refs/heads/feature/test
prunable gitdir file points to non-existent location
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git branch -d -- feature/test': {
        error: new Error("cannot delete branch 'feature/test' used by worktree at '/repo-stale'")
      },
      'git branch -d -- feature/test#2': {
        stdout: ''
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual([
      'git worktree list --porcelain -z',
      // The cleanliness probe that decides whether the checkout may be renamed aside.
      'git status --porcelain --untracked-files=all',
      'git worktree remove /repo-feature',
      'git branch -d -- feature/test',
      'git worktree prune',
      'git branch -d -- feature/test'
    ])
  })

  it('renames the checkout aside and deregisters the missing path', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })
    moveWorktreeDirectoryToTrashMock.mockResolvedValue('/trash/wt-1-abcdef01')

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(moveWorktreeDirectoryToTrashMock).toHaveBeenCalledWith('/repo-feature')
    expect(scheduleWorktreeTrashDeletionMock).toHaveBeenCalledWith('/trash/wt-1-abcdef01')
    expect(calls).toContain('git worktree remove --force /repo-feature')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', '/repo-feature'],
      { cwd: '/repo', timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS }
    )
    expect(calls).not.toContain('git worktree remove /repo-feature')
    expect(calls).not.toContain('git worktree prune')
    expect(calls).toContain('git branch -d -- feature/test')
  })

  it('prunes the registration when deregistering the moved checkout fails', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree remove --force /repo-feature': {
        error: new Error('fatal: validation failed, cannot remove working directory')
      }
    })
    moveWorktreeDirectoryToTrashMock.mockResolvedValue('/trash/wt-2-abcdef02')

    await removeWorktree('/repo', '/repo-feature')

    expect(getGitCalls()).toContain('git worktree prune')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/repo',
      timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
    })
    expect(
      gitExecFileAsyncMock.mock.calls.filter(
        ([args, options]) =>
          args.join(' ') === 'worktree list --porcelain -z' &&
          options.timeout === WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
      )
    ).toHaveLength(2)
    expect(scheduleWorktreeTrashDeletionMock).toHaveBeenCalledWith('/trash/wt-2-abcdef02')
    expect(restoreWorktreeDirectoryFromTrashMock).not.toHaveBeenCalled()
  })

  it('restores the moved checkout and removes in place when the registration survives pruning', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree remove --force /repo-feature': {
        error: new Error('fatal: validation failed, cannot remove working directory')
      }
    })
    moveWorktreeDirectoryToTrashMock.mockResolvedValue('/trash/wt-3-abcdef03')

    await removeWorktree('/repo', '/repo-feature')

    expect(restoreWorktreeDirectoryFromTrashMock).toHaveBeenCalledWith(
      '/trash/wt-3-abcdef03',
      '/repo-feature'
    )
    expect(scheduleWorktreeTrashDeletionMock).not.toHaveBeenCalled()
    expect(getGitCalls()).toContain('git worktree remove /repo-feature')
  })

  it('removes in place when the checkout cannot be renamed aside', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })
    // Windows open handles and cross-volume renames both surface as an unavailable rename.
    moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined)

    await removeWorktree('/repo', '/repo-feature')

    expect(getGitCalls()).toContain('git worktree remove /repo-feature')
    expect(scheduleWorktreeTrashDeletionMock).not.toHaveBeenCalled()
  })

  it('never renames a dirty checkout aside', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git status --porcelain --untracked-files=all': { stdout: ' M src/app.ts\n' },
      'git worktree remove /repo-feature': {
        error: new Error('fatal: contains modified or untracked files, use --force to delete it')
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).rejects.toThrow(
      'contains modified or untracked files'
    )
    expect(moveWorktreeDirectoryToTrashMock).not.toHaveBeenCalled()
  })

  it('deletes WSL-hosted checkouts in place inside the distro', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })

    await removeWorktree('/repo', '/repo-feature', false, { wslDistro: 'Ubuntu' })

    expect(moveWorktreeDirectoryToTrashMock).not.toHaveBeenCalled()
    expect(getGitCalls()).not.toContain('git status --porcelain --untracked-files=all')
    expect(getGitCalls()).toContain('git worktree remove /repo-feature')
  })

  it('does not rename a WSL checkout configured for a native Windows repo', async () => {
    const originalPlatform = process.platform
    const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\feature'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      mockGitCommands({})

      await removeWorktree('C:\\repo', worktreePath, false, {
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(moveWorktreeDirectoryToTrashMock).not.toHaveBeenCalled()
      expect(getGitCalls()).toEqual([`git worktree remove ${worktreePath}`])
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('passes one --force before the worktree path for dirty-file removal', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })

    await removeWorktree('/repo', '/repo-feature', true)

    expect(getGitCalls()).toContain('git worktree remove --force /repo-feature')
  })

  it('force-retries removal when git refuses a clean worktree containing an initialised submodule', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree remove /repo-feature': {
        error: new Error('git worktree remove failed'),
        stderr: 'fatal: working trees containing submodules cannot be moved or removed'
      },
      'git status --porcelain --untracked-files=all': { stdout: '' }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expectGitCallOrder(
      calls,
      'git worktree remove /repo-feature',
      'git worktree remove --force /repo-feature'
    )
    // The re-proof of cleanliness between the refusal and the forced retry.
    expect(calls.lastIndexOf('git status --porcelain --untracked-files=all')).toBeGreaterThan(
      calls.indexOf('git worktree remove /repo-feature')
    )
    expect(calls.lastIndexOf('git status --porcelain --untracked-files=all')).toBeLessThan(
      calls.indexOf('git worktree remove --force /repo-feature')
    )
    expect(calls).toContain('git branch -d -- feature/test')
  })

  it('surfaces uncommitted changes instead of force-removing a dirty submodule worktree', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree remove /repo-feature': {
        error: new Error('git worktree remove failed'),
        stderr: 'fatal: working trees containing submodules cannot be moved or removed'
      },
      'git status --porcelain --untracked-files=all': { stdout: ' M sub\n' }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).rejects.toThrow(
      'Worktree has uncommitted or untracked changes.'
    )
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
  })

  it('does not force-retry when the caller already forced removal', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree remove --force /repo-feature': {
        error: new Error('git worktree remove failed'),
        stderr: 'fatal: working trees containing submodules cannot be moved or removed'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature', true)).rejects.toThrow()
    expect(
      getGitCalls().filter((call) => call === 'git worktree remove --force /repo-feature')
    ).toHaveLength(1)
  })

  it('does not force-retry unrelated non-force remove failures', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree remove /repo-feature': {
        error: new Error('git worktree remove failed'),
        stderr: 'fatal: contains modified or untracked files, use --force to delete it'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).rejects.toThrow(
      'git worktree remove failed'
    )
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
    // Only the pre-rename probe ran: an unrelated failure must not re-prove cleanliness.
    expect(
      getGitCalls().filter((call) => call === 'git status --porcelain --untracked-files=all')
    ).toHaveLength(1)
  })

  it('rejects a locked worktree with stable app-owned copy before invoking remove', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
locked active agent session
`
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature', true)).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session.'
    )
    expect(getGitCalls()).not.toContain('git worktree remove /repo-feature')
  })

  it('does not treat dirty-file force as permission to override a lock', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
locked active agent session
`
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature', true)).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session.'
    )
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
  })

  it('matches Windows worktree paths before deleting the branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree C:/repo
HEAD abc123
branch refs/heads/main

worktree C:/Workspaces/Delete-Branch-Ui-Test
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree C:/repo
HEAD abc123
branch refs/heads/main
`
      }
    })

    await removeWorktree('C:\\repo', 'c:\\workspaces\\delete-branch-ui-test')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove c:\\workspaces\\delete-branch-ui-test',
        'git branch -d -- feature/test'
      ])
    )
    expect(calls).not.toContain('git worktree prune')
  })
})

describe('removeWorktree sparse-checkout cache invalidation', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('drops the removed worktree path so a re-created worktree at the same path is re-detected', async () => {
    await detectSparseCheckoutCached('/repo', '/repo-feature')
    expect(__getSparseCheckoutStateCacheSizeForTests()).toBe(1)

    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      }
    })

    await removeWorktree('/repo', '/repo-feature', false, { deleteBranch: false })

    // Why not assert size 0: the pre-removal `listWorktrees` lookup inside `performRemoveWorktree`
    // re-annotates every row it saw (including the untouched main worktree), caching a fresh entry
    // for `/repo`. Only the removed path's own entry must be gone, proven by a fresh stat call below.
    const statCallsBefore = statMock.mock.calls.length
    expect(await detectSparseCheckoutCached('/repo', '/repo-feature')).toBe(false)
    expect(statMock.mock.calls.length).toBeGreaterThan(statCallsBefore)
  })
})
