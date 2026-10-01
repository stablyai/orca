import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

const membershipReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('./worktree-membership/worktree-membership-store', async (importOriginal) => {
  const store = (
    await import('./worktree-membership-store-git-answered-mock')
  ).gitAnsweredMembershipStoreMock(await importOriginal())
  return {
    ...store,
    readWorktreeMembership: (...args: Parameters<typeof store.readWorktreeMembership>) => {
      membershipReads.count += 1
      return store.readWorktreeMembership(...args)
    }
  }
})

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

import { removeWorktree } from './worktree'
import {
  __getSparseCheckoutStateCacheSizeForTests,
  detectSparseCheckoutCached
} from './worktree-sparse-checkout-cache'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

// Why: removal argv carries core.longpaths on Windows, so pin a non-Windows default or the
// exact-argv assertions below fail for a maintainer running vitest on Windows.
let platformSpy: MockInstance<() => NodeJS.Platform>

beforeEach(() => {
  resetWorktreeRemovalState()
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  platformSpy.mockRestore()
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

  it('looks the removed worktree up with Git, not the shared membership read', async () => {
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
    membershipReads.count = 0

    await removeWorktree('/repo', '/repo-feature')

    expect(getGitCalls()).toContain('git branch -d -- feature/test')
    expect(membershipReads.count).toBe(0)
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
      'git worktree remove /repo-feature',
      'git branch -d -- feature/test',
      'git worktree prune',
      'git branch -d -- feature/test'
    ])
  })

  it('lets Git delete the checkout inline with no deadline', async () => {
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

    // A large checkout takes Git 30 s or more to delete; any timeout here would cut that short.
    // Exempt from general admission: deletes queue under their own limit instead.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'remove', '/repo-feature'], {
      cwd: '/repo',
      admissionExempt: true
    })
    expect(getGitCalls()).not.toContain('git worktree prune')
    expect(getGitCalls()).toContain('git branch -d -- feature/test')
  })

  it('lets a quit stop only the checkout delete, not the branch cleanup that holds ref locks', async () => {
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
    const stop = new AbortController()

    await removeWorktree('/repo', '/repo-feature', false, {
      checkoutDeleteSignal: stop.signal
    })

    const optionsOf = (command: string): { signal?: AbortSignal } | undefined =>
      gitExecFileAsyncMock.mock.calls.find((call) => call[0].join(' ') === command)?.[1]
    expect(optionsOf('worktree remove /repo-feature')?.signal).toBe(stop.signal)
    expect(optionsOf('branch -d -- feature/test')).toBeDefined()
    expect(optionsOf('branch -d -- feature/test')?.signal).toBeUndefined()
  })

  it('never lets Git run an inherited yes/no prompt program during the delete', async () => {
    vi.stubEnv('GIT_ASK_YESNO', '/usr/local/bin/prompt')
    try {
      mockGitCommands({})

      await removeWorktree('/repo', '/repo-feature', false, {
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      const [, removeOptions] = gitExecFileAsyncMock.mock.calls[0]
      expect(removeOptions.env).toBeDefined()
      expect(removeOptions.env).not.toHaveProperty('GIT_ASK_YESNO')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('deletes what Git left of the checkout after a successful remove', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-'))
    const worktreePath = join(scratch, 'feature')
    // Git for Windows leaves junctions and the directories holding them behind yet exits 0.
    await mkdir(join(worktreePath, 'node_modules', 'left-behind'), { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(getGitCalls()).toEqual([`git worktree remove ${worktreePath}`])
      expect(existsSync(worktreePath)).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('leaves a WSL checkout that Git reported removed to the distro', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-wsl-'))
    const worktreePath = join(scratch, 'feature')
    await mkdir(worktreePath, { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        wslDistro: 'Ubuntu',
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('leaves a dirty checkout to Git to refuse', async () => {
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
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
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

    expect(getGitCalls()).not.toContain('git status --porcelain --untracked-files=all')
    expect(getGitCalls()).toContain('git worktree remove /repo-feature')
  })

  it('removes a WSL checkout configured for a native Windows repo with Git alone', async () => {
    const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\feature'
    platformSpy.mockReturnValue('win32')
    mockGitCommands({})

    await removeWorktree('C:\\repo', worktreePath, false, {
      knownRemovedWorktree: { branch: '', head: '', locked: false }
    })

    expect(getGitCalls()).toEqual([`git -c core.longpaths=true worktree remove ${worktreePath}`])
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
    // An unrelated failure must not re-prove cleanliness.
    expect(getGitCalls()).not.toContain('git status --porcelain --untracked-files=all')
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
