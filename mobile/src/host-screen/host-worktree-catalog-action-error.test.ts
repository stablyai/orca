import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../cache/worktree-cache', () => ({ setCachedWorktrees: () => {} }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

type Worktree = { worktreeId: string; repo: string; isPinned: boolean }

const CONFIRMED: Worktree[] = [{ worktreeId: 'wt-1', repo: 'orca', isPinned: false }]

/**
 * The clear the list depends on to stop showing a failure the host has since disproved.
 *
 * A confirmed catalog is the host answering, which is the evidence that a transient action failure
 * was about a moment that has passed. Nothing else clears it but the user's own dismiss.
 */
function catalogHook(
  fetched: unknown,
  actionErrors: string[],
  catalogErrors: (string | null)[],
  catalogFetch?: () => Promise<unknown>
) {
  const state = {
    clientRef: { current: {} },
    fetchWorktreesInFlightRef: { current: null },
    newWorktreeModalVisibleRef: { current: false },
    setActionError: (value: string) => actionErrors.push(value),
    setCatalogError: (value: string | null) => catalogErrors.push(value),
    setLastKnownWorktrees: () => {},
    setOptimisticActiveWorktreeIdentity: () => {},
    setPinnedIds: (apply: (previous: Set<string>) => Set<string>) => apply(new Set()),
    setSleptIds: (apply: (previous: Set<string>) => Set<string>) => apply(new Set()),
    setWorktrees: () => {},
    setWorktreesLoaded: () => {},
    worktreeCatalogRef: {
      current: {
        fetch: catalogFetch ?? (async () => fetched),
        admit: () => (fetched === null && !catalogFetch ? null : CONFIRMED)
      }
    }
  }
  return {
    client: state.clientRef.current,
    connState: 'connected',
    embedded: true,
    fetchRepoMetadata: async () => {},
    hostId: 'host-1',
    state,
    syncViewSettingsFromDesktop: async () => {}
  }
}

async function fetchWith(fetched: unknown): Promise<{
  actionErrors: string[]
  catalogErrors: (string | null)[]
}> {
  const actionErrors: string[] = []
  const catalogErrors: (string | null)[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads the members named above off `state` and the rest of its arguments only to decide whether to fetch; every module that would reach further is mocked in this file.
  const args = catalogHook(fetched, actionErrors, catalogErrors) as unknown as Parameters<
    typeof useHostWorktreeCatalog
  >[0]
  const held: {
    fetchWorktrees: ((options?: { allowDuringModal?: boolean }) => Promise<unknown>) | null
  } = { fetchWorktrees: null }
  function Probe(): null {
    held.fetchWorktrees = useHostWorktreeCatalog(args).fetchWorktrees
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  const fetchWorktrees = held.fetchWorktrees
  if (fetchWorktrees === null) {
    throw new Error('the catalog hook did not mount')
  }
  await act(async () => {
    await fetchWorktrees()
  })
  return { actionErrors, catalogErrors }
}

describe('a catalog the host confirmed', () => {
  it('clears the action failure the list is still showing', async () => {
    const { actionErrors, catalogErrors } = await fetchWith({
      kind: 'response',
      pending: { admission: { kind: 'valid' } }
    })
    expect(actionErrors).toEqual([''])
    expect(catalogErrors).toEqual([null])
  })

  it('leaves it standing when the request itself failed, which proves nothing', async () => {
    const { actionErrors, catalogErrors } = await fetchWith({
      kind: 'request_failed',
      code: 'network_error'
    })
    expect(actionErrors).toEqual([])
    expect(catalogErrors).toEqual(['network_error'])
  })
})

describe('the fetch a handoff awaits', () => {
  it('returns the confirmed list, so callers needing the refreshed rows get them', async () => {
    const actionErrors: string[] = []
    const catalogErrors: (string | null)[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reachable surface as fetchWith above.
    const args = catalogHook(
      { kind: 'response', pending: { admission: { kind: 'valid' } } },
      actionErrors,
      catalogErrors
    ) as unknown as Parameters<typeof useHostWorktreeCatalog>[0]
    const held: {
      fetchWorktrees: ((options?: { allowDuringModal?: boolean }) => Promise<unknown>) | null
    } = { fetchWorktrees: null }
    function Probe(): null {
      held.fetchWorktrees = useHostWorktreeCatalog(args).fetchWorktrees
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })
    await expect(held.fetchWorktrees?.()).resolves.toEqual(CONFIRMED)
  })

  it('shares the in-flight request instead of leaving a concurrent caller empty-handed', async () => {
    // A holder, not a `let`: control flow would narrow a `let` to its null initializer here and
    // call the later assignment — made inside the fetch callback — unreachable typing.
    const releaser: { release: (() => void) | null } = { release: null }
    const catalogCalls: number[] = []
    const actionErrors: string[] = []
    const catalogErrors: (string | null)[] = []
    const catalogFetch = () =>
      new Promise((resolve) => {
        catalogCalls.push(catalogCalls.length)
        releaser.release = () =>
          resolve({ kind: 'response', pending: { admission: { kind: 'valid' } } })
      })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reachable surface as fetchWith above.
    const args = catalogHook(
      { kind: 'response', pending: { admission: { kind: 'valid' } } },
      actionErrors,
      catalogErrors,
      catalogFetch
    ) as unknown as Parameters<typeof useHostWorktreeCatalog>[0]
    const held: {
      fetchWorktrees: ((options?: { allowDuringModal?: boolean }) => Promise<unknown>) | null
    } = { fetchWorktrees: null }
    function Probe(): null {
      held.fetchWorktrees = useHostWorktreeCatalog(args).fetchWorktrees
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })
    const first = held.fetchWorktrees?.({ allowDuringModal: true })
    const second = held.fetchWorktrees?.({ allowDuringModal: true })
    releaser.release?.()
    await expect(first).resolves.toEqual(CONFIRMED)
    // The Add project handoff fires right after a poll tick can have started one; it must
    // await that request's list, not resolve undefined and silently skip the session hop.
    await expect(second).resolves.toEqual(CONFIRMED)
    expect(catalogCalls).toEqual([0])
  })
})
