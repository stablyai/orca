import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { listWorktrees } from './worktree'

const WORKTREE_LIST_OUTPUT = `worktree /repo
HEAD abc123
branch refs/heads/main
`

describe('worktree Git capabilities', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('does not repeat a known-unsupported -z probe on later scans', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('-z')) {
        return Promise.reject(
          Object.assign(new Error('git usage error'), {
            code: 129,
            stderr: 'usage: git worktree list [<options>]\n'
          })
        )
      }
      return Promise.resolve({ stdout: WORKTREE_LIST_OUTPUT })
    })

    await listWorktrees('/repo')
    await listWorktrees('/repo')

    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['worktree', 'list', '--porcelain', '-z'],
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'list', '--porcelain']
    ])
  })

  it('keeps native and WSL Git capability results separate', async () => {
    gitExecFileAsyncMock.mockImplementation(
      (args: string[], options: { cwd: string; wslDistro?: string }) => {
        if (args.includes('-z') && !options.wslDistro) {
          return Promise.reject(
            Object.assign(new Error('git usage error'), {
              code: 129,
              stderr: 'usage: git worktree list [<options>]\n'
            })
          )
        }
        return Promise.resolve({
          stdout: `worktree ${options.cwd}\nHEAD abc123\nbranch refs/heads/main\n`
        })
      }
    )

    await listWorktrees('/native-repo')
    await listWorktrees('/wsl-repo', { wslDistro: 'Ubuntu' })

    expect(
      gitExecFileAsyncMock.mock.calls.map(([args, options]) => ({
        args,
        wslDistro: options.wslDistro
      }))
    ).toEqual([
      { args: ['worktree', 'list', '--porcelain', '-z'], wslDistro: undefined },
      { args: ['worktree', 'list', '--porcelain'], wslDistro: undefined },
      { args: ['worktree', 'list', '--porcelain', '-z'], wslDistro: 'Ubuntu' }
    ])
  })

  it('does not repeat a known-unsupported rev-parse --path-format probe', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree') {
        return Promise.resolve({
          stdout: 'worktree /git-store/project.git\nHEAD abc123\nbranch refs/heads/main\n'
        })
      }
      if (args.includes('--path-format=absolute')) {
        return Promise.reject(
          Object.assign(new Error('unknown option: --path-format=absolute'), {
            stderr: 'error: unknown option `path-format=absolute`\n'
          })
        )
      }
      return Promise.resolve({ stdout: '/repo\n/git-store/project.git\n' })
    })

    await listWorktrees('/repo')
    await listWorktrees('/repo')

    const revParseCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => (args as string[])[0] === 'rev-parse'
    )
    expect(revParseCalls.map(([args]) => args)).toEqual([
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      ['rev-parse', '--show-toplevel', '--git-common-dir'],
      ['rev-parse', '--show-toplevel', '--git-common-dir']
    ])
  })

  it('remembers old Git that echoes --path-format while exiting successfully', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree') {
        return Promise.resolve({
          stdout: 'worktree /git-store/project.git\nHEAD abc123\nbranch refs/heads/main\n'
        })
      }
      if (args.includes('--path-format=absolute')) {
        return Promise.resolve({
          stdout: '--path-format=absolute\n/repo\n/git-store/project.git\n'
        })
      }
      return Promise.resolve({ stdout: '/repo\n/git-store/project.git\n' })
    })

    await listWorktrees('/repo')
    await listWorktrees('/repo')

    const revParseCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => (args as string[])[0] === 'rev-parse'
    )
    expect(revParseCalls.map(([args]) => args)).toEqual([
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      ['rev-parse', '--show-toplevel', '--git-common-dir']
    ])
  })
})
