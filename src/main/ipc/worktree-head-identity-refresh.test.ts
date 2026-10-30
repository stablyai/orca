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

// Move only wall time to test event-driven promotion without firing the catch-up timer.
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

    await refreshWorktreeHeadIdentities(host, state, true, EMPTY_HEAD_IDENTITY_SCOPE)

    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('promotes one refresh per interval back to a full re-read', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    await refreshWorktreeHeadIdentities(host, state, false)

    await refreshWorktreeHeadIdentities(host, state, true, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(lastScope()).toEqual(PRIMARY_HEAD_IDENTITY_SCOPE)

    // External update-ref can move a branch without any watched admin-directory write.
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

    // Empty-scope structural churn must not starve the full freshness checkpoint.
    skipInterval()
    mockRead([identity('bbb')])
    // Structural catalog notification carries the head; empty-scope promotion silently repairs the baseline.
    await refreshWorktreeHeadIdentities(host, state, false, EMPTY_HEAD_IDENTITY_SCOPE)

    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()

    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await refreshWorktreeHeadIdentities(host, state, false, EMPTY_HEAD_IDENTITY_SCOPE)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()
  })

  it('does not arm the freshness clock on a full read that could not enumerate', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    // Failed enumeration cannot prove a complete freshness checkpoint.
    mockRead([identity('aaa')], false)
    await refreshWorktreeHeadIdentities(host, state, false)
    mockRead([identity('aaa')])

    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(FULL_HEAD_IDENTITY_SCOPE)

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

    // Failed publication must preserve the old baseline so the next refresh retries the notification.
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
    // macOS window recreation can strand a queued scope behind a destroyed-window guard.
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

    mockRead([identity('aaa'), other])
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(notifyWorktreeHeadIdentitiesChanged).not.toHaveBeenCalled()
  })

  it('catches up with no further events after a scoped refresh', async () => {
    const host = makeHost()
    const state = createWorktreeHeadIdentityRefreshState()
    mockRead([identity('aaa')])
    await refreshWorktreeHeadIdentities(host, state, false)

    // A scoped pass needs a one-shot full read even if no further event arrives.
    await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('wt-a'))
    expect(lastScope()).toEqual(headIdentityScopeForEntry('wt-a'))

    // Model an unwatched external ref update followed by complete event silence.
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
    await refreshWorktreeHeadIdentities(host, state, false)
    expect(state.rebaselineTimer).toBeNull()

    vi.mocked(readGitCommonHeadIdentities).mockClear()
    await vi.advanceTimersByTimeAsync(HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS * 5)
    expect(readGitCommonHeadIdentities).not.toHaveBeenCalled()

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
