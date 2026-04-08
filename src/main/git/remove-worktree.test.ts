import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  // runner.ts imports spawn from child_process; stub prevents
  // "missing export" errors when the mock is resolved transitively.
  spawn: vi.fn()
}))

// Why: runner.ts uses promisify(execFile). The default promisify of a test
// mock doesn't return { stdout, stderr } because the mock lacks Node's
// util.promisify.custom symbol. Return a wrapper that invokes the callback-
// style execFileMock and shapes the result correctly.
vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {
    ...actual,
    promisify: vi.fn(() =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          execFileMock(
            ...args,
            (error: Error | null, stdout: string, stderr: string) => {
              if (error) {
                reject(Object.assign(error, { stdout, stderr }))
                return
              }
              resolve({ stdout, stderr })
            }
          )
        })
    )
  }
})

import { removeWorktree } from './worktree'

type MockResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

function mockGitCommands(results: Record<string, MockResult>): void {
  const callCounts = new Map<string, number>()
  execFileMock.mockImplementation(
    (
      file: string,
      args: string[],
      options: { cwd: string; encoding: string } | ((...params: unknown[]) => void),
      callback?: (...params: unknown[]) => void
    ) => {
      const resolvedCallback = typeof options === 'function' ? options : callback
      const key = `${file} ${args.join(' ')}`
      const callCount = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, callCount)
      const result = results[`${key}#${callCount}`] ?? results[key] ?? {}

      if (result.error) {
        const error = Object.assign(result.error, {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? ''
        })
        resolvedCallback?.(error, result.stdout ?? '', result.stderr ?? '')
        return
      }

      resolvedCallback?.(null, result.stdout ?? '', result.stderr ?? '')
    }
  )
}

function getGitCalls(): string[] {
  return execFileMock.mock.calls.map((call) => `${call[0]} ${call[1].join(' ')}`)
}

function expectGitCallOrder(calls: string[], beforeCall: string, afterCall: string): void {
  expect(calls.indexOf(beforeCall)).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf(afterCall)).toBeGreaterThan(calls.indexOf(beforeCall))
}

describe('removeWorktree', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
  })

  it('removes the worktree, prunes stale refs, and deletes its local branch', async () => {
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
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git worktree prune',
        'git branch -D feature/test'
      ])
    )
    expectGitCallOrder(calls, 'git worktree remove /repo-feature', 'git worktree prune')
    expectGitCallOrder(calls, 'git worktree prune', 'git branch -D feature/test')
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
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git worktree prune',
        'git worktree list --porcelain'
      ])
    )
    expect(calls).not.toContain('git branch -D feature/test')
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
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git worktree prune',
        'git branch -D feature/test'
      ])
    )
    expectGitCallOrder(calls, 'git worktree prune', 'git branch -D feature/test')
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
        'git worktree prune',
        'git branch -D feature/test'
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
      'git branch -D feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'branch delete failed'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Failed to delete local branch "feature/test" after removing worktree',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })
})
