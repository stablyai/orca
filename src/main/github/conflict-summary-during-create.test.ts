import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: while a local create checks out, a card poll (a request a client awaits) must answer at
// once from what is already known — no git, and no wait on a create that can take minutes.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { __resetPRConflictSummaryCachesForTests, getPRConflictSummary } from './conflict-summary'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate,
  LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS
} from '../git/local-worktree-create-activity'

const handlers: Record<string, () => Promise<{ stdout: string }>> = {
  fetch: async () => ({ stdout: '' }),
  'rev-parse': async () => ({ stdout: 'base-tip-1\n' }),
  'merge-base': async () => ({ stdout: 'merge-base-1\n' }),
  'rev-list': async () => ({ stdout: '3\n' }),
  'merge-tree': async () => ({ stdout: 'tree-oid\u0000src/conflict.ts\u0000' })
}

const expectedSummary = {
  baseRef: 'main',
  baseCommit: 'base-ti',
  commitsBehind: 3,
  files: ['src/conflict.ts']
}

function summary(headRefOid: string, admissionTier?: 'interactive' | 'background') {
  return getPRConflictSummary(
    '/repo-root',
    'main',
    'github-base-oid',
    headRefOid,
    admissionTier ? { admissionTier } : {}
  )
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => handlers[argv[0]]())
  __resetPRConflictSummaryCachesForTests()
})

afterEach(() => {
  _resetLocalWorktreeCreateActivityForTests()
})

describe('conflict summary while a local create runs', () => {
  it('answers a background lookup from the last known summary without running git', async () => {
    await expect(summary('head-1', 'background')).resolves.toEqual(expectedSummary)
    gitExecFileAsyncMock.mockClear()
    // Even past the base-tip freshness window the answer must come from cache, not a new fetch.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10 * 60_000)

    holdLocalWorktreeCreate()
    await expect(summary('head-1', 'background')).resolves.toEqual(expectedSummary)
    await expect(summary('head-1')).resolves.toEqual(expectedSummary)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('answers nothing yet, rather than waiting, when nothing is cached', async () => {
    holdLocalWorktreeCreate()
    await expect(summary('head-never-seen', 'background')).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('still computes a manual (interactive) refresh', async () => {
    holdLocalWorktreeCreate()
    await expect(summary('head-2', 'interactive')).resolves.toEqual(expectedSummary)
    expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv[0])).toContain('merge-tree')
  })

  it('computes normally again once the create settles', async () => {
    const release = holdLocalWorktreeCreate()
    await summary('head-3', 'background')
    release()
    await expect(summary('head-3', 'background')).resolves.toEqual(expectedSummary)
    expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv[0])).toContain('merge-tree')
  })

  it('computes normally once a stuck create outlasts the deadline', async () => {
    vi.useFakeTimers()
    holdLocalWorktreeCreate()
    vi.advanceTimersByTime(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS)
    vi.useRealTimers()
    await expect(summary('head-4', 'background')).resolves.toEqual(expectedSummary)
    expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv[0])).toContain('merge-tree')
  })
})
