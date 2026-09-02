import { describe, expect, it } from 'vitest'
import {
  hasSettledHostRepoList,
  hostRepoListReducer,
  initialHostRepoList,
  needsHostRepoListFetch,
  type HostRepoListState
} from './host-repo-list'

type Repo = { id: string }

function reduce(
  state: HostRepoListState<Repo>,
  ...actions: Parameters<typeof hostRepoListReducer<Repo>>[1][]
): HostRepoListState<Repo> {
  return actions.reduce(hostRepoListReducer<Repo>, state)
}

const idle = initialHostRepoList<Repo>()

describe('hostRepoListReducer', () => {
  it('keeps the last good list while a reload is in flight', () => {
    const loaded = reduce(idle, { type: 'requested' }, { type: 'resolved', repos: [{ id: 'a' }] })
    expect(reduce(loaded, { type: 'requested' })).toEqual({
      status: 'loading',
      repos: [{ id: 'a' }],
      error: ''
    })
  })

  it('keeps the last good list when a reload fails, and records why', () => {
    const loaded = reduce(idle, { type: 'resolved', repos: [{ id: 'a' }] })
    expect(reduce(loaded, { type: 'requested' }, { type: 'failed', error: 'offline' })).toEqual({
      status: 'error',
      repos: [{ id: 'a' }],
      error: 'offline'
    })
  })

  it('clears a previous host completely on reset', () => {
    const loaded = reduce(idle, { type: 'resolved', repos: [{ id: 'a' }] })
    expect(reduce(loaded, { type: 'reset' })).toEqual(idle)
  })

  it('returns the identical state when a reset or repeat request changes nothing', () => {
    expect(hostRepoListReducer<Repo>(idle, { type: 'reset' })).toBe(idle)
    const loading = reduce(idle, { type: 'requested' })
    expect(hostRepoListReducer<Repo>(loading, { type: 'requested' })).toBe(loading)
  })
})

describe('host repo list readiness', () => {
  // Regression (#12966): an empty list read as "this host has no repos", so the
  // Project board filtered every row against [] and rendered "No project items".
  it('does not treat an unfetched or in-flight list as settled', () => {
    expect(hasSettledHostRepoList(idle)).toBe(false)
    expect(hasSettledHostRepoList(reduce(idle, { type: 'requested' }))).toBe(false)
  })

  it('settles on success and on failure, so the UI never waits forever', () => {
    expect(hasSettledHostRepoList(reduce(idle, { type: 'resolved', repos: [] }))).toBe(true)
    expect(hasSettledHostRepoList(reduce(idle, { type: 'failed', error: 'nope' }))).toBe(true)
  })

  it('re-fetches after a failure but not after an empty success', () => {
    expect(needsHostRepoListFetch(idle)).toBe(true)
    expect(needsHostRepoListFetch(reduce(idle, { type: 'failed', error: 'nope' }))).toBe(true)
    // A host with no repos is a real answer; asking again on every load is waste.
    expect(needsHostRepoListFetch(reduce(idle, { type: 'resolved', repos: [] }))).toBe(false)
  })
})
