/**
 * The relay and the desktop each carried their own `getErrorText`, and they had
 * drifted: the relay read `message` + `stderr` + `stdout`, the desktop only
 * `message` + `stderr`. So a `git branch -d` refusal that arrived on `stdout`
 * routed the SSH removal through prune-and-retry while the local removal gave up
 * and preserved the branch.
 *
 * These tests push the same failure through both published removal entry points —
 * `removeWorktreeOp` (what `git.removeWorktree` runs on the host) and `removeWorktree`
 * (the local runner) — and require the same branch-deletion commands and the same
 * `RemoveWorktreeResult`. A second error-text reader on either side fails here.
 */
import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, resolveGitDirMock, moveWorktreeDirectoryToTrashMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    resolveGitDirMock: vi.fn(),
    moveWorktreeDirectoryToTrashMock: vi.fn()
  })
)

vi.mock('../main/worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: vi.fn(async () => true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

vi.mock('../main/git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))

vi.mock('../main/git/status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    stat: vi.fn(async () => {
      throw enoent()
    }),
    readFile: vi.fn()
  }
})

import { GitCapabilityCache } from '../shared/git-capability-cache'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { clearGitCapabilityStateForTests } from '../main/git/git-capability-state'
import { _resetWorktreeScanCacheForTests, removeWorktree } from '../main/git/worktree'
import { __resetSparseCheckoutStateCacheForTests } from '../main/git/worktree-sparse-checkout-cache'
import type { GitExec } from './git-handler-ops'
import { removeWorktreeOp } from './git-handler-worktree-ops'

const REPO_PATH = '/repo'
const WORKTREE_PATH = '/repo-feature'
const BRANCH = 'feature/test'

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

/** Only the branch-deletion phase; the two entry points legitimately reach it by different routes. */
function branchDeletionCalls(calls: string[][]): string[] {
  return calls
    .map((args) => args.join(' '))
    .filter((call) => call.startsWith('branch ') || call === 'worktree prune')
}

function worktreeListPorcelain(withFeature: boolean): string {
  const blocks = [[`worktree ${REPO_PATH}`, 'HEAD abc123', 'branch refs/heads/main']]
  if (withFeature) {
    blocks.push([`worktree ${WORKTREE_PATH}`, 'HEAD def456', `branch refs/heads/${BRANCH}`])
  }
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`
}

type RefusalStream = 'stdout' | 'stderr'

const REFUSAL_TEXT = `error: cannot delete branch '${BRANCH}' used by worktree at '/repo-stale'`

/**
 * A `branch -d` rejection carrying the refusal on exactly one stream. `message` stays
 * generic so the assertion is about the stream, not about Node's stderr echo.
 */
function branchDeleteRefusal(stream: RefusalStream): Error {
  return Object.assign(new Error('Command failed: git branch -d'), {
    code: 1,
    stdout: stream === 'stdout' ? REFUSAL_TEXT : '',
    stderr: stream === 'stderr' ? REFUSAL_TEXT : ''
  })
}

/** Refuses the first `branch -d`, accepts the retry that follows `worktree prune`. */
function scriptRelayGit(stream: RefusalStream): {
  git: GitExec
  calls: string[][]
} {
  const calls: string[][] = []
  let branchDeleteCount = 0
  const git = vi.fn<GitExec>(async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') {
      return { stdout: `${REPO_PATH}/.git\n`, stderr: '' }
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { stdout: worktreeListPorcelain(true), stderr: '' }
    }
    if (args[0] === 'branch' && args[1] === '-d') {
      branchDeleteCount += 1
      if (branchDeleteCount === 1) {
        throw branchDeleteRefusal(stream)
      }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  return { git, calls }
}

function scriptDesktopGit(stream: RefusalStream): string[][] {
  const calls: string[][] = []
  let branchDeleteCount = 0
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { stdout: worktreeListPorcelain(branchDeleteCount === 0), stderr: '' }
    }
    if (args[0] === 'branch' && args[1] === '-d') {
      branchDeleteCount += 1
      if (branchDeleteCount === 1) {
        throw branchDeleteRefusal(stream)
      }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  return calls
}

async function removeOverRelay(
  stream: RefusalStream
): Promise<{ result: RemoveWorktreeResult; branchCalls: string[] }> {
  const { git, calls } = scriptRelayGit(stream)
  const result = await removeWorktreeOp(
    git,
    { worktreePath: WORKTREE_PATH },
    new GitCapabilityCache()
  )
  return { result, branchCalls: branchDeletionCalls(calls) }
}

async function removeLocally(
  stream: RefusalStream
): Promise<{ result: RemoveWorktreeResult; branchCalls: string[] }> {
  const calls = scriptDesktopGit(stream)
  const result = await removeWorktree(REPO_PATH, WORKTREE_PATH)
  return { result, branchCalls: branchDeletionCalls(calls) }
}

beforeEach(() => {
  clearGitCapabilityStateForTests()
  _resetWorktreeScanCacheForTests()
  __resetSparseCheckoutStateCacheForTests()
  gitExecFileAsyncMock.mockReset()
  resolveGitDirMock.mockReset()
  resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
  moveWorktreeDirectoryToTrashMock.mockReset()
  // Default: the checkout cannot be renamed aside, so removal runs `worktree remove` in place.
  moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined)
})

describe('relay/desktop branch-delete refusal parity', () => {
  it('prunes and retries on both paths when the refusal arrives on stdout', async () => {
    const relay = await removeOverRelay('stdout')
    const local = await removeLocally('stdout')

    expect(relay.branchCalls).toEqual(local.branchCalls)
    expect(relay.result).toEqual(local.result)
    expect(local.branchCalls).toEqual([
      `branch -d -- ${BRANCH}`,
      'worktree prune',
      `branch -d -- ${BRANCH}`
    ])
    expect(local.result).toEqual({})
  })

  it('prunes and retries on both paths when the refusal arrives on stderr, as real Git sends it', async () => {
    const relay = await removeOverRelay('stderr')
    const local = await removeLocally('stderr')

    expect(relay.branchCalls).toEqual(local.branchCalls)
    expect(relay.result).toEqual(local.result)
    expect(local.branchCalls).toEqual([
      `branch -d -- ${BRANCH}`,
      'worktree prune',
      `branch -d -- ${BRANCH}`
    ])
  })
})
