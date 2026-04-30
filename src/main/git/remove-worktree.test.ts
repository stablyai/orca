/* eslint-disable max-lines -- Why: remove/list/sparse cleanup tests share one git runner
   mock harness, and splitting them would duplicate setup without a clearer boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { addSparseWorktree, listWorktrees, removeWorktree } from './worktree'

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
    const result = results[`${key}#${callCount}`] ?? results[key] ?? {}

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
  })

  it('removes the worktree, prunes stale refs, and deletes its local branch', async () => {
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
      'git worktree list --porcelain -z': {
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
      'git worktree list --porcelain -z#2': {
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
        'git worktree list --porcelain -z'
      ])
    )
    expect(calls).not.toContain('git branch -D feature/test')
    expectGitCallOrder(calls, 'git worktree remove /repo-feature', 'git worktree prune')
  })

  it('deletes the branch after prune removes stale sibling worktree entries', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
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
      'git worktree list --porcelain -z#2': {
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
      }
    })

    await removeWorktree('/repo', '/repo-feature', true)

    expect(getGitCalls()).toContain('git worktree remove --force /repo-feature')
  })

  it('matches Windows worktree paths before deleting the branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        stdout: `worktree C:/repo
HEAD abc123
branch refs/heads/main

worktree C:/Workspaces/Delete-Branch-Ui-Test
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain -z#2': {
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

describe('listWorktrees', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockReset()
    translateWslOutputPathsMock.mockImplementation((output: string) => output)
  })

  it('translates parsed path fields from NUL-delimited porcelain output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /home/me/repo\0HEAD abc123\0branch refs/heads/main\0\0' +
        'worktree /home/me/repo-feature\0HEAD def456\0branch refs/heads/feature/test\0sparse\0\0'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) => {
      expect(output).not.toContain('\0')
      return output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    })

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
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z', 'git sparse-checkout list'])
    expect(translateWslOutputPathsMock).toHaveBeenCalledTimes(2)
  })

  it('detects sparse checkout after translating paths when porcelain omits sparse token', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[], options: { cwd: string }) => {
      if (args.join(' ') === 'worktree list --porcelain -z') {
        return {
          stdout:
            'worktree /home/me/repo\0HEAD abc123\0branch refs/heads/main\0\0' +
            'worktree /home/me/repo-feature\0HEAD def456\0branch refs/heads/feature/test\0\0',
          stderr: ''
        }
      }
      if (args.join(' ') === 'sparse-checkout list') {
        const isFeatureWorktree =
          options.cwd === '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature'
        return {
          stdout: isFeatureWorktree ? 'packages/web\n' : '',
          stderr: ''
        }
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })
    translateWslOutputPathsMock.mockImplementation((output: string) => {
      expect(output).not.toContain('\0')
      return output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
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
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['sparse-checkout', 'list'], {
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature'
    })
  })
})

describe('addSparseWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockReset()
    translateWslOutputPathsMock.mockImplementation((output: string) => output)
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
      'git sparse-checkout set -- packages/web': {
        error: new Error('sparse setup failed')
      },
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
      }
    })

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['packages/web'])
    ).rejects.toThrow('sparse setup failed')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree add --no-checkout -b feature/test /repo-feature',
        'git sparse-checkout init --cone',
        'git sparse-checkout set -- packages/web',
        'git worktree remove --force /repo-feature',
        'git worktree prune',
        'git branch -D feature/test'
      ])
    )
    expectGitCallOrder(
      calls,
      'git sparse-checkout set -- packages/web',
      'git worktree remove --force /repo-feature'
    )
    expectGitCallOrder(calls, 'git worktree prune', 'git branch -D feature/test')
  })
})
