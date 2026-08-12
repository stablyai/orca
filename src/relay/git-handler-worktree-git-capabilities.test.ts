import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

type GitSpyTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

const WORKTREE_LIST_OUTPUT = `worktree /repo
HEAD abc123
branch refs/heads/main
`

describe('relay worktree Git capabilities', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  it('does not repeat a known-unsupported -z probe on later scans', async () => {
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementation((args: string[]) => {
        if (args.includes('-z')) {
          return Promise.reject(
            Object.assign(new Error('git usage error'), {
              code: 129,
              stderr: 'usage: git worktree list [<options>]\n'
            })
          )
        }
        return Promise.resolve({ stdout: WORKTREE_LIST_OUTPUT, stderr: '' })
      })

    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })

    expect(gitSpy.mock.calls.map(([args]) => args)).toEqual([
      ['worktree', 'list', '--porcelain', '-z'],
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'list', '--porcelain']
    ])
  })

  it('re-probes after a relay handler is replaced', async () => {
    const mockOldGit = (target: GitHandler) =>
      vi.spyOn(target as unknown as GitSpyTarget, 'git').mockImplementation((args: string[]) => {
        if (args.includes('-z')) {
          return Promise.reject(
            Object.assign(new Error('git usage error'), {
              code: 129,
              stderr: 'usage: git worktree list [<options>]\n'
            })
          )
        }
        return Promise.resolve({ stdout: WORKTREE_LIST_OUTPUT, stderr: '' })
      })
    const firstGit = mockOldGit(handler)
    const replacementDispatcher = createMockDispatcher()
    const replacementHandler = new GitHandler(
      replacementDispatcher as unknown as RelayDispatcher,
      new RelayContext()
    )
    const replacementGit = mockOldGit(replacementHandler)

    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    await replacementDispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })

    expect(firstGit.mock.calls.filter(([args]) => args.includes('-z'))).toHaveLength(1)
    expect(replacementGit.mock.calls.filter(([args]) => args.includes('-z'))).toHaveLength(1)
  })

  it('does not repeat a known-unsupported rev-parse --path-format probe', async () => {
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementation((args: string[]) => {
        if (args[0] === 'worktree') {
          return Promise.resolve({
            stdout: 'worktree /git-store/project.git\nHEAD abc123\nbranch refs/heads/main\n',
            stderr: ''
          })
        }
        if (args.includes('--path-format=absolute')) {
          return Promise.reject(
            Object.assign(new Error('unknown option: --path-format=absolute'), {
              stderr: 'error: unknown option `path-format=absolute`\n'
            })
          )
        }
        return Promise.resolve({
          stdout: '/repo\n/git-store/project.git\n',
          stderr: ''
        })
      })

    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })

    const revParseCalls = gitSpy.mock.calls.filter(([args]) => args[0] === 'rev-parse')
    expect(revParseCalls.map(([args]) => args)).toEqual([
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      ['rev-parse', '--show-toplevel', '--git-common-dir'],
      ['rev-parse', '--show-toplevel', '--git-common-dir']
    ])
  })
})
