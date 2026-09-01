import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'

vi.mock('./worktree-remote', () => ({
  notifyWorktreeHeadIdentitiesChanged: vi.fn()
}))

vi.mock('./worktree-head-identity-reader', () => ({
  readGitCommonHeadIdentities: vi.fn(async () => [] as WorktreeHeadIdentity[]),
  createWorktreeHeadIdentityCache: vi.fn(() => ({
    entries: new Map(),
    entryNames: null,
    primary: null
  }))
}))

import { notifyWorktreeHeadIdentitiesChanged } from './worktree-remote'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'
import {
  createWorktreeHeadIdentityRefreshState,
  HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS,
  refreshWorktreeHeadIdentities
} from './worktree-head-identity-refresh'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry,
  PRIMARY_HEAD_IDENTITY_SCOPE
} from './worktree-head-identity-scope'

const COMMON_DIR = '/repos/project/.git'
const WT_A = '/repos/wt-a'

function makeHost(): Parameters<typeof refreshWorktreeHeadIdentities>[0] {
  return {
    path: COMMON_DIR,
    repos: new Map([['repo-1', {}]]),
    mainWindow: { isDestroyed: () => false } as never,
    disposed: false
  }
}

function identity(head: string): WorktreeHeadIdentity {
  return { worktreePath: WT_A, head, branch: 'refs/heads/feature' }
}

function lastScope(): unknown {
  return vi.mocked(readGitCommonHeadIdentities).mock.calls.at(-1)?.[2]
}

describe('refreshWorktreeHeadIdentities', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(readGitCommonHeadIdentities).mockReset()
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([])
    vi.mocked(notifyWorktreeHeadIdentitiesChanged).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads everything on cold start and does not emit off a missing baseline', async () => {
    const state = createWorktreeHeadIdentityRefreshState()
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([identity('aaa')])

    await refreshWorktreeHeadIdentities(makeHost(), state, true, headIdentityScopeForEntry('wt-a'))

    // A scoped first call still cannot trust an empty memo.
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('forwards a narrowed scope once a baseline exists', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)

    vi.mocked(readGitCommonHeadIdentities).mockResolvedValue([identity('bbb')])
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    expect(lastScope()).toEqual(headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1', [
      identity('bbb')
    ])
  })

  it('reads nothing when the burst provably cannot move a head', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)
    vi.mocked(readGitCommonHeadIdentities).mockClear()

    // A `locked` / `config.worktree` write classifies to the empty scope.
    await refreshWorktreeHeadIdentities(host, state, true, EMPTY_HEAD_IDENTITY_SCOPE)

    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('promotes one refresh per interval back to a full re-read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(PRIMARY_HEAD_IDENTITY_SCOPE)

    // A ref can move with no event under any admin dir (`git update-ref` from a
    // sibling worktree), so the blind window has to be bounded.
    vi.advanceTimersByTime(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS)
    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)

    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(PRIMARY_HEAD_IDENTITY_SCOPE)
  })

  it('merges the scopes of refreshes queued behind an in-flight read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    let release: () => void = () => {}
    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([])
        })
    )
    const inFlight = refreshWorktreeHeadIdentities(
      host,
      state,
      true,
      headIdentityScopeForEntry('wt-a')
    )
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-b'))
    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    release()
    await inFlight
    await vi.advanceTimersByTimeAsync(0)

    expect(lastScope()).toEqual({
      listing: false,
      primary: true,
      all: false,
      entryNames: new Set(['wt-b'])
    })
  })

  it('re-reads everything after a failed read rather than trusting a partial memo', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(readGitCommonHeadIdentities).mockRejectedValueOnce(new Error('EIO'))

    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
  })

  it('never emits for a window torn down mid-read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(async () => {
      host.disposed = true
      return [identity('bbb')]
    })
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })
})
