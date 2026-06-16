/* eslint-disable max-lines -- Why: remove/list/sparse cleanup tests share one git runner
   mock harness, and splitting them would duplicate setup without a clearer boundary. */
import type * as FsPromises from 'fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock }
})

import {
  addSparseWorktree,
  assertWorktreeCleanForRemoval,
  forceDeleteLocalBranch,
  listWorktrees,
  removeWorktree
} from './worktree'

type MockResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

function mockGitCommands(results: Record<string, MockResult>): void {
  const callCounts = new Map<string, number>()
  gitExecFileAsyncMock.mockImplementation((args: string[]) => {
    const key = `git ${args.join(' ')}`
    const callCount = (callCounts.get(key) ?? 0) + 1
    callCounts.set(key, callCount)
    const lineListKey =
      key === 'git worktree list --porcelain -z' ? 'git worktree list --porcelain' : ''
    const result =
      results[`${key}#${callCount}`] ??
      results[key] ??
      (lineListKey
        ? (results[`${lineListKey}#${callCount}`] ?? results[lineListKey])
        : undefined) ??
      {}

    if (result.error) {
      throw Object.assign(result.error, {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
      })
    }

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    }
  })
}

function getGitCalls(): string[] {
  return gitExecFileAsyncMock.mock.calls.map((call) => `git ${call[0].join(' ')}`)
}

function expectGitCallOrder(calls: string[], beforeCall: string, afterCall: string): void {
  expect(calls.indexOf(beforeCall)).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf(afterCall)).toBeGreaterThan(calls.indexOf(beforeCall))
}

describe('removeWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockReset()
    translateWslOutputPathsMock.mockImplementation((output: string) => output)
    statMock.mockReset()
    // Default: no worktree has a sparse-checkout config file. Tests that need
    // sparse detection override this.
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    resolveGitDirMock.mockReset()
    resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
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
    expectGitCallOrder(calls, 'git worktree remove /repo-feature', 'git worktree prune')
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
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git worktree prune',
        'git branch -d -- feature/test'
      ])
    )
    expect(calls.lastIndexOf('git branch -d -- feature/test')).toBeGreaterThan(
      calls.indexOf('git worktree prune')
    )
  })

  it('passes --force before the worktree path when forced removal is requested', async () => {
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
  })

  it('keeps removal successful when branch cleanup fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'branch delete failed'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Preserved local branch "feature/test" after removing worktree (not fully merged)',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })

  it('deletes a squash-merged branch when merging it into the base is a no-op', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain -z#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'error: the branch feature/test is not fully merged'
      },
      'git config --get branch.feature/test.base': {
        stdout: 'refs/remotes/origin/main\n'
      },
      'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
        stdout: 'base123\n'
      },
      'git merge-tree --write-tree base123 refs/heads/feature/test': {
        stdout: 'tree123\n'
      },
      'git rev-parse --verify --quiet base123^{tree}': {
        stdout: 'tree123\n'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})

    const calls = getGitCalls()
    expect(calls).toContain('git branch -d -- feature/test')
    expect(calls).toContain('git merge-tree --write-tree base123 refs/heads/feature/test')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git config --remove-section branch.feature/test')
  })

  it('refreshes the saved remote base before deleting a safe-delete-rejected branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain -z#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'error: the branch feature/test is not fully merged'
      },
      'git config --get branch.feature/test.base': {
        stdout: 'refs/remotes/origin/main\n'
      },
      'git remote': {
        stdout: 'origin\n'
      },
      'git fetch --prune origin': {
        stdout: ''
      },
      'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
        stdout: 'base123\n'
      },
      'git merge-tree --write-tree base123 refs/heads/feature/test': {
        stdout: 'tree123\n'
      },
      'git rev-parse --verify --quiet base123^{tree}': {
        stdout: 'tree123\n'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})

    const calls = getGitCalls()
    expect(calls).toContain('git fetch --prune origin')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expectGitCallOrder(
      calls,
      'git fetch --prune origin',
      'git merge-tree --write-tree base123 refs/heads/feature/test'
    )
    expectGitCallOrder(
      calls,
      'git fetch --prune origin',
      'git update-ref -d refs/heads/feature/test def456'
    )
  })

  it('preserves an already-merged branch when cleanup races after worktree removal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGitCommands({
      'git worktree list --porcelain -z': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain -z#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'error: the branch feature/test is not fully merged'
      },
      'git config --get branch.feature/test.base': {
        stdout: 'refs/remotes/origin/main\n'
      },
      'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
        stdout: 'base123\n'
      },
      'git rev-list --right-only --merges --count base123...refs/heads/feature/test': {
        stdout: '0\n'
      },
      'git cherry -v base123 refs/heads/feature/test': {
        stdout: '- def456 fix: already squash-merged\n'
      },
      'git update-ref -d refs/heads/feature/test def456': {
        error: new Error('cannot lock ref')
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Failed to delete already-merged local branch "feature/test" after removing worktree',
      expect.any(Error)
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Preserved local branch "feature/test" after removing worktree (not fully merged)',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('force-deletes a preserved branch only at its saved head', async () => {
    mockGitCommands({})

    await forceDeleteLocalBranch('/repo', 'feature/test', 'def456')

    const calls = getGitCalls()
    expect(calls).toContain('git worktree list --porcelain')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git config --remove-section branch.feature/test')
  })

  it('refuses to force-delete a preserved branch that is checked out again', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'checked out in another worktree'
    )
    expect(getGitCalls()).not.toContain('git update-ref -d refs/heads/feature/test def456')
  })

  it('restores a preserved branch when a concurrent checkout wins after deletion', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo-feature
HEAD 0000000000000000000000000000000000000000
branch refs/heads/feature/test
`
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'checked out in another worktree'
    )
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      'refs/heads/feature/test',
      'def456',
      ''
    ])
  })

  it('refuses to force-delete a preserved branch after its head changes', async () => {
    mockGitCommands({
      'git update-ref -d refs/heads/feature/test def456': {
        error: new Error('cannot lock ref')
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'changed after the workspace was deleted'
    )
    expect(getGitCalls()).not.toContain('git config --remove-section branch.feature/test')
  })
})

describe('assertWorktreeCleanForRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns without checking git status for force removals', async () => {
    await expect(assertWorktreeCleanForRemoval('/repo-feature', true)).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('passes when git status output is empty', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).resolves.toBeUndefined()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: '/repo-feature' }
    )
  })

  it('throws a dedicated dirty/untracked error when status output is non-empty', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '?? scratch.txt\n', stderr: '' })

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).rejects.toMatchObject({
      message: 'Worktree has uncommitted or untracked changes.',
      stdout: '?? scratch.txt\n'
    })
  })

  it('rethrows preflight subprocess failures as-is', async () => {
    const error = Object.assign(new Error('fatal: not a git repository'), {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
    })
    gitExecFileAsyncMock.mockRejectedValueOnce(error)

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).rejects.toBe(error)
  })
})

describe('listWorktrees', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockReset()
    translateWslOutputPathsMock.mockImplementation((output: string) => output)
    statMock.mockReset()
    // Default: no worktree has a sparse-checkout config file. Tests that need
    // sparse detection override this.
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    resolveGitDirMock.mockReset()
    resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
  })

  it('translates parsed path fields from line-block porcelain output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
        'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\nsparse\n\n'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )

    await expect(listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).resolves.toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    // Why: the non-sparse main worktree gets an fs probe of its sparse config
    // file; the linked worktree short-circuits on the parsed `sparse` token and
    // does not. Only one git subprocess runs regardless of worktree count.
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(translateWslOutputPathsMock).toHaveBeenCalledTimes(2)
  })

  it('returns no worktrees when the repo path is gone', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn git ENOENT'), {
        code: 'ENOENT'
      })
    )
    statMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(listWorktrees('/workspace/deleted-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/workspace/deleted-repo'
    })
    expect(statMock).toHaveBeenCalledWith('/workspace/deleted-repo')
    expect(warnSpy).toHaveBeenCalledWith(
      '[git/worktree] repo path missing; skipping worktree list: /workspace/deleted-repo'
    )
    warnSpy.mockRestore()
  })

  it('returns no worktrees when the path exists but is not a git repo', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: git worktree list --porcelain'), {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )

    await expect(listWorktrees('/private/tmp/orca-issue-1582-test/my-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/private/tmp/orca-issue-1582-test/my-repo'
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('detects sparse checkout after translating paths when porcelain omits sparse token', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.join(' ') === 'worktree list --porcelain -z') {
        return {
          stdout:
            'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
            'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n',
          stderr: ''
        }
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )
    const featureWorktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature'
    resolveGitDirMock.mockImplementation(async (worktreePath: string) =>
      worktreePath === featureWorktreePath
        ? `${featureWorktreePath}\\.git-worktrees\\feature`
        : `${worktreePath}/.git`
    )
    statMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes('repo-feature') && filePath.includes('sparse-checkout')) {
        return { isFile: () => true, size: 32 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const worktrees = await listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')

    expect(worktrees).toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(resolveGitDirMock).toHaveBeenCalledWith(featureWorktreePath)
    // Why: the detection path must not spawn a git subprocess per worktree —
    // the perf regression in #1131 came from `git sparse-checkout list` firing
    // on every poll.
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
  })

  it('bounds concurrent sparse-checkout filesystem probes', async () => {
    const worktreeCount = 20
    const sparseWorktreePath = '/repo-worktree-17'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: Array.from({ length: worktreeCount }, (_, index) =>
        [
          `worktree ${index === 0 ? '/repo' : `/repo-worktree-${index}`}`,
          `HEAD ${String(index).padStart(6, '0')}`,
          `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
          ''
        ].join('\n')
      ).join('\n'),
      stderr: ''
    })

    const pendingProbeResolves: (() => void)[] = []
    let activeProbes = 0
    let maxActiveProbes = 0
    statMock.mockImplementation(async (filePath: string) => {
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      await new Promise<void>((resolve) => pendingProbeResolves.push(resolve))
      activeProbes -= 1

      if (filePath.includes(sparseWorktreePath)) {
        return { isFile: () => true, size: 32 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    let completed = false
    const listPromise = listWorktrees('/repo').finally(() => {
      completed = true
    })

    for (let attempt = 0; pendingProbeResolves.length < 8 && attempt < 20; attempt += 1) {
      await Promise.resolve()
    }
    expect(pendingProbeResolves).toHaveLength(8)

    for (let attempt = 0; !completed && attempt < 20; attempt += 1) {
      pendingProbeResolves.splice(0).forEach((resolve) => resolve())
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(completed).toBe(true)

    const worktrees = await listPromise

    expect(maxActiveProbes).toBeLessThanOrEqual(8)
    expect(statMock).toHaveBeenCalledTimes(worktreeCount)
    expect(worktrees).toHaveLength(worktreeCount)
    expect(worktrees[17]).toMatchObject({
      path: sparseWorktreePath,
      isSparse: true
    })
  })

  it('falls back to line-block porcelain output when Git rejects -z', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
      }
    })

    await expect(listWorktrees('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      }
    ])
    expect(getGitCalls()).toEqual([
      'git worktree list --porcelain -z',
      'git worktree list --porcelain'
    ])
  })
})

describe('addSparseWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockReset()
    translateWslOutputPathsMock.mockImplementation((output: string) => output)
    statMock.mockReset()
    // Default: no worktree has a sparse-checkout config file. Tests that need
    // sparse detection override this.
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    resolveGitDirMock.mockReset()
    resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
  })

  it('separates sparse checkout directory operands from options', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['-docs', 'src'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['sparse-checkout', 'set', '--', '-docs', 'src'],
      { cwd: '/repo-feature' }
    )
  })

  it('removes the worktree and deletes the created branch when sparse setup fails', async () => {
    mockGitCommands({
      // Why: addWorktree probes push.autoSetupRemote after `worktree add` to
      // decide whether to set it locally. Without an explicit mock the helper
      // returns empty stdout and the production code skips the `--local` write,
      // exercising the wrong branch. Throw with code 1 to mirror git's "key
      // unset" exit, which is what worktree.ts treats as "needs to be set".
      'git config --get push.autoSetupRemote': {
        error: Object.assign(new Error('key unset'), { code: 1 })
      },
      'git sparse-checkout set -- packages/web': {
        error: new Error('sparse setup failed')
      },
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

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['packages/web'])
    ).rejects.toThrow('sparse setup failed')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree add --no-checkout --no-track -b feature/test /repo-feature',
        'git config --get push.autoSetupRemote',
        'git config --local push.autoSetupRemote true',
        'git sparse-checkout init --cone',
        'git sparse-checkout set -- packages/web',
        'git worktree remove --force /repo-feature',
        'git branch -D -- feature/test'
      ])
    )
    expectGitCallOrder(
      calls,
      'git sparse-checkout set -- packages/web',
      'git worktree remove --force /repo-feature'
    )
    expectGitCallOrder(
      calls,
      'git worktree remove --force /repo-feature',
      'git branch -D -- feature/test'
    )
  })
})
