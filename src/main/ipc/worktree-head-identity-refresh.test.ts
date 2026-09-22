import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'

vi.mock('./worktree-remote', () => ({
  notifyWorktreeHeadIdentitiesChanged: vi.fn()
}))

vi.mock('./worktree-head-identity-reader', () => ({
  readGitCommonHeadIdentities: vi.fn(async () => ({
    identities: [] as WorktreeHeadIdentity[],
    complete: true
  })),
  createWorktreeHeadIdentityCache: vi.fn(() => ({
    entries: new Map(),
    unverified: new Set(),
    entryNames: null,
    primary: null,
    primaryUnverified: false
  }))
}))

import { notifyWorktreeHeadIdentitiesChanged } from './worktree-remote'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'
import {
  createWorktreeHeadIdentityRefreshState,
  disposeWorktreeHeadIdentityRefreshState,
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

const windowState = { destroyed: false }

function makeHost(): Parameters<typeof refreshWorktreeHeadIdentities>[0] {
  return {
    path: COMMON_DIR,
    repos: new Map([['repo-1', {}]]),
    mainWindow: { isDestroyed: () => windowState.destroyed } as never,
    disposed: false
  }
}

function identity(head: string): WorktreeHeadIdentity {
  return { worktreePath: WT_A, head, branch: 'refs/heads/feature' }
}

function mockRead(identities: WorktreeHeadIdentity[] = [], complete = true): void {
  vi.mocked(readGitCommonHeadIdentities).mockResolvedValue({ identities, complete })
}

// Advance only the clock, so promotion-on-the-next-event is exercised without
// the one-shot catch-up timer firing and muddling the assertion.
function skipInterval(): void {
  vi.setSystemTime(Date.now() + HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS)
}

function lastScope(): unknown {
  return vi.mocked(readGitCommonHeadIdentities).mock.calls.at(-1)?.[2]
}

describe('refreshWorktreeHeadIdentities', () => {
  beforeEach(() => {
    windowState.destroyed = false
    vi.useFakeTimers()
    vi.mocked(readGitCommonHeadIdentities).mockReset()
    mockRead()
    vi.mocked(notifyWorktreeHeadIdentitiesChanged).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads everything on cold start and does not emit off a missing baseline', async () => {
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])

    await refreshWorktreeHeadIdentities(makeHost(), state, true, headIdentityScopeForEntry('wt-a'))

    // A scoped first call still cannot trust an empty memo.
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('forwards a narrowed scope once a baseline exists', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)

    mockRead([identity('bbb')])
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
    skipInterval()
    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)

    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(PRIMARY_HEAD_IDENTITY_SCOPE)
  })

  it('still takes the periodic re-baseline when only empty-scope events arrive', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)
    vi.mocked(readGitCommonHeadIdentities).mockClear()

    // `git worktree lock`/`unlock` and sparse toggles classify to the empty
    // scope. They must not be able to starve the re-baseline that bounds the
    // window where a ref moved with no event under any admin dir.
    skipInterval()
    mockRead([identity('bbb')])
    // An empty scope only ever reaches the refresh from a structural burst, so
    // the reachable pairing is `emit: false`: the promotion's job here is
    // baseline/cache hygiene, and the structural catalog notification that runs
    // in the same flush is what publishes the head.
    await refreshWorktreeHeadIdentities(host, state, false, EMPTY_HEAD_IDENTITY_SCOPE)

    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    // Re-baselined, so the next narrow burst diffs against the fresh head
    // instead of re-reporting a move the catalog already published.
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    // The promotion also re-arms the interval, so the next empty burst is free.
    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await refreshWorktreeHeadIdentities(host, state, false, EMPTY_HEAD_IDENTITY_SCOPE)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('does not arm the freshness clock on a full read that could not enumerate', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    // A full read whose `worktrees/` listing failed has not seen entries added
    // since the last good listing, so it is not a freshness checkpoint.
    mockRead([identity('aaa')], false)
    await refreshWorktreeHeadIdentities(host, state, false)
    mockRead([identity('aaa')])

    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)

    // That one enumerated, so the clock arms and the next narrow burst stays narrow.
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(headIdentityScopeForEntry('wt-a'))
  })

  it('merges the scopes of refreshes queued behind an in-flight read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    let release: () => void = () => {}
    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ identities: [], complete: true })
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

  it('keeps the baseline when a notify throws so the move is retried', async () => {
    const host = makeHost()
    host.repos = new Map([
      ['repo-1', {}],
      ['repo-2', {}]
    ])
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)

    // A send into destroyed chrome throws part-way through the repo loop.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRead([identity('bbb')])
    vi.mocked(notifyWorktreeHeadIdentitiesChanged).mockImplementationOnce(() => {
      throw new Error('webContents destroyed')
    })
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    // The baseline must still hold `aaa`, so the next refresh re-reports `bbb`
    // rather than diffing it away as already published.
    vi.mocked(notifyWorktreeHeadIdentitiesChanged).mockClear()
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1', [
      identity('bbb')
    ])
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-2', [
      identity('bbb')
    ])
  })

  it('folds a queued scope back in when its re-run met a destroyed window', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    let release: () => void = () => {}
    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ identities: [], complete: true })
        })
    )
    const inFlight = refreshWorktreeHeadIdentities(
      host,
      state,
      true,
      headIdentityScopeForEntry('wt-a')
    )
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-b'))
    // macOS recreates the window while the watch lives on: the queued re-run
    // returns at the teardown guard and must not lose the scope with it.
    windowState.destroyed = true
    release()
    await inFlight
    await vi.advanceTimersByTimeAsync(0)

    windowState.destroyed = false
    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-c'))

    expect(lastScope()).toEqual({
      listing: false,
      primary: false,
      all: false,
      entryNames: new Set(['wt-b', 'wt-c'])
    })
  })

  it('does not treat a read discarded by teardown as a freshness checkpoint', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)
    skipInterval()

    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(async () => {
      windowState.destroyed = true
      return { identities: [identity('bbb')], complete: true }
    })
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    windowState.destroyed = false
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
  })

  it('carries forward baseline rows an incomplete listing could not observe', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    const other = { worktreePath: '/repos/wt-b', head: 'ccc', branch: 'refs/heads/other' }
    mockRead([identity('aaa'), other])
    await refreshWorktreeHeadIdentities(host, state, false)

    // Enumeration failed, so wt-b is missing from this pass entirely.
    mockRead([identity('aaa')], false)
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    // Listing recovers with wt-b unchanged: it must not be reported as moved.
    mockRead([identity('aaa'), other])
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('catches up with no further events after a scoped refresh', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)

    // A scoped pass leaves any drift it could not see unbounded, so it arms a
    // one-shot catch-up rather than waiting for an event that may never come.
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(headIdentityScopeForEntry('wt-a'))

    // External `git update-ref` moved the head with no watched write, then total
    // silence: no burst, no debounce flush, nothing.
    mockRead([identity('bbb')])
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS)

    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
    expect(notifyWorktreeHeadIdentitiesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1', [
      identity('bbb')
    ])
    disposeWorktreeHeadIdentityRefreshState(state)
  })

  it('schedules nothing while idle, so a quiet repo costs no background reads', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    // Cold start is a full pass: it disarms rather than arming, because nothing
    // is outstanding after a full read.
    await refreshWorktreeHeadIdentities(host, state, false)
    expect(state.rebaselineTimer).toBeNull()

    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS * 5)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()

    // Re-baseline so the scoped pass below stays scoped, then check that the
    // catch-up it arms disarms once it has run: never a recurring poll.
    await refreshWorktreeHeadIdentities(host, state, false, FULL_HEAD_IDENTITY_SCOPE)
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(state.rebaselineTimer).not.toBeNull()
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS)
    expect(state.rebaselineTimer).toBeNull()

    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS * 5)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('stops the catch-up when the watch is disposed', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    disposeWorktreeHeadIdentityRefreshState(state)
    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS * 2)

    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('never emits for a window torn down mid-read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    vi.mocked(readGitCommonHeadIdentities).mockImplementationOnce(async () => {
      host.disposed = true
      return { identities: [identity('bbb')], complete: true }
    })
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))

    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })
})
