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
  rowReuse: boolean[],
  clocks: (number | undefined)[]
) {
  let admitted = false
  const applyRows = (apply: (previous: Worktree[]) => Worktree[]) =>
    rowReuse.push(apply(CONFIRMED) === CONFIRMED)
  const state = {
    clientRef: { current: {} },
    fetchWorktreesInFlightRef: { current: false },
    newWorktreeModalVisibleRef: { current: false },
    setActionError: (value: string) => actionErrors.push(value),
    setCatalogError: (value: string | null) => catalogErrors.push(value),
    setLastKnownWorktrees: applyRows,
    setOptimisticActiveWorktreeIdentity: () => {},
    setPinnedIds: (apply: (previous: Set<string>) => Set<string>) => apply(new Set()),
    setSleptIds: (apply: (previous: Set<string>) => Set<string>) => apply(new Set()),
    setWorktrees: applyRows,
    setWorktreesLoaded: () => {},
    worktreeCatalogRef: {
      current: {
        fetch: async () => fetched,
        admit: () => {
          admitted = true
          return fetched === null ? null : CONFIRMED
        },
        clockOffsetFor: () => clocks[admitted ? 1 : 0]
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

async function fetchWith(
  fetched: unknown,
  clocks: (number | undefined)[] = []
): Promise<{
  actionErrors: string[]
  catalogErrors: (string | null)[]
  rowReuse: boolean[]
}> {
  const actionErrors: string[] = []
  const catalogErrors: (string | null)[] = []
  const rowReuse: boolean[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads the members named above off `state` and the rest of its arguments only to decide whether to fetch; every module that would reach further is mocked in this file.
  const args = catalogHook(
    fetched,
    actionErrors,
    catalogErrors,
    rowReuse,
    clocks
  ) as unknown as Parameters<typeof useHostWorktreeCatalog>[0]
  const held: { fetchWorktrees: (() => Promise<void>) | null } = { fetchWorktrees: null }
  function Probe(): null {
    held.fetchWorktrees = useHostWorktreeCatalog(args).fetchWorktrees
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  if (held.fetchWorktrees === null) {
    throw new Error('the catalog hook did not mount')
  }
  await act(held.fetchWorktrees)
  return { actionErrors, catalogErrors, rowReuse }
}

describe('a catalog the host confirmed', () => {
  it('redraws retained rows when an unchanged reply changes the clock calibration', async () => {
    const response = { kind: 'response', pending: { admission: { kind: 'unchanged' } } }
    expect((await fetchWith(response, [0, 60_000])).rowReuse).toEqual([false, false])
    expect((await fetchWith(response, [0, 0])).rowReuse).toEqual([true, true])
  })
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
