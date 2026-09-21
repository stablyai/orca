/**
 * Issue #14004: a relay-side worktree-list failure must stay a failure across the relay/provider
 * boundary. Converting it to `[]` reports an unreadable catalog as an authoritative empty one, and
 * downstream reconciliation uses that to authorize missing-worktree teardown.
 */
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

/** Git <2.36 rejects `worktree list -z` with a usage error, which routes the handler to the fallback lane. */
function unsupportedZError(): Error {
  return Object.assign(new Error('git usage error'), {
    code: 129,
    stderr: 'usage: git worktree list [<options>]\n'
  })
}

describe('relay worktree-list authority (#14004)', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  it('rejects instead of reporting an empty catalog when the fallback listing fails', async () => {
    vi.spyOn(handler as unknown as GitSpyTarget, 'git').mockImplementation((args: string[]) =>
      args.includes('-z')
        ? Promise.reject(unsupportedZError())
        : Promise.reject(
            Object.assign(new Error('fatal: not a git repository'), { code: 128, stderr: '' })
          )
    )

    await expect(
      dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    ).rejects.toThrow('not a git repository')
  })

  it('rejects a timed-out fallback listing on a host whose -z support is already known absent', async () => {
    const gitSpy = vi
      .spyOn(handler as unknown as GitSpyTarget, 'git')
      .mockImplementation((args: string[]) =>
        args.includes('-z')
          ? Promise.reject(unsupportedZError())
          : Promise.resolve({ stdout: WORKTREE_LIST_OUTPUT, stderr: '' })
      )
    // Prime the capability cache so the probe is not repeated; later scans go straight to the fallback.
    await dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })

    gitSpy.mockRejectedValue(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))

    await expect(
      dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    ).rejects.toThrow('ETIMEDOUT')
    expect(gitSpy.mock.calls.at(-1)?.[0]).toEqual(['worktree', 'list', '--porcelain'])
  })

  it('republishes the catalog when a later fallback listing succeeds', async () => {
    let failListing = true
    vi.spyOn(handler as unknown as GitSpyTarget, 'git').mockImplementation((args: string[]) => {
      if (args.includes('-z')) {
        return Promise.reject(unsupportedZError())
      }
      return failListing
        ? Promise.reject(new Error('transient relay failure'))
        : Promise.resolve({ stdout: WORKTREE_LIST_OUTPUT, stderr: '' })
    })

    await expect(
      dispatcher.callRequest('git.listWorktrees', { repoPath: '/repo' })
    ).rejects.toThrow('transient relay failure')

    failListing = false
    const result = (await dispatcher.callRequest('git.listWorktrees', {
      repoPath: '/repo'
    })) as Record<string, unknown>[]
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ path: '/repo', isMainWorktree: true })
  })
})
