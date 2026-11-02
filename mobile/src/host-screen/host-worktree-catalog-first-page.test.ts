import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({ AppState: {} }))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import { useHostWorktreeCatalog } from './use-host-worktree-catalog'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useHostScreenState } from './use-host-screen-state'
import { WORKTREE_FIRST_PAGE_LIMIT } from '../worktree/worktree-catalog-first-page'

const reply = (result: unknown): RpcResponse => ({
  id: 'r',
  ok: true,
  result,
  _meta: { runtimeId: 'runtime' }
})
const row = (worktreeId: string) => ({ worktreeId, repoId: 'repo', path: `/w/${worktreeId}` })

async function mountCatalog(options: { deferFirstPage?: boolean } = {}) {
  let settleFirstPage: () => void = () => {}
  let settleFull: (response: RpcResponse | Error) => void = () => {}
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (_method: string, params?: unknown) => {
    const firstPage =
      typeof params === 'object' && params !== null && 'limit' in params
        ? params.limit === WORKTREE_FIRST_PAGE_LIMIT
        : false
    if (firstPage) {
      const page = reply({ worktrees: [row('pinned')], totalCount: 3, truncated: true })
      return options.deferFirstPage
        ? new Promise<RpcResponse>((resolve) => (settleFirstPage = () => resolve(page)))
        : page
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      settleFull = (response) => (response instanceof Error ? reject(response) : resolve(response))
    })
  })
  const seen: { worktreeIds: string[]; loaded: boolean; fetch: () => Promise<void> } = {
    worktreeIds: [],
    loaded: false,
    fetch: async () => {}
  }
  function Probe(): null {
    const state = useHostScreenState('host-1')
    state.clientRef.current = client
    const catalog = useHostWorktreeCatalog({
      client,
      connState: 'connected',
      embedded: true,
      fetchRepoMetadata: async () => {},
      hostCapabilities: [],
      hostId: 'host-1',
      sidebarFeed: null,
      state,
      syncViewSettingsFromDesktop: async () => {}
    })
    seen.worktreeIds = state.worktrees.map((w) => w.worktreeId)
    seen.loaded = state.worktreesLoaded
    seen.fetch = catalog.fetchWorktrees
    return null
  }
  let renderer: ReturnType<typeof create> | null = null
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  return {
    seen,
    settleFull: (r: RpcResponse | Error) => settleFull(r),
    settleFirstPage: () => settleFirstPage(),
    unmount: () => act(() => renderer?.unmount())
  }
}

describe('the first page of a host catalog', () => {
  it('draws the first rows while the full catalog arrives, then the full catalog', async () => {
    const { seen, settleFull, unmount } = await mountCatalog()
    let fetching: Promise<void> = Promise.resolve()
    await act(async () => {
      fetching = seen.fetch()
    })
    expect(seen).toMatchObject({ worktreeIds: ['pinned'], loaded: false })

    await act(async () => {
      settleFull(reply({ worktrees: [row('pinned'), row('a'), row('b')], snapshotId: 's1' }))
      await fetching
    })
    expect(seen).toMatchObject({ worktreeIds: ['pinned', 'a', 'b'], loaded: true })
    unmount()
  })

  it('does not leave the first page looking like the whole host when the full read fails', async () => {
    const { seen, settleFull, unmount } = await mountCatalog()
    let fetching: Promise<void> = Promise.resolve()
    await act(async () => {
      fetching = seen.fetch()
    })
    expect(seen.worktreeIds).toEqual(['pinned'])
    await act(async () => {
      settleFull(new Error('network disconnected'))
      await fetching
    })
    expect(seen).toMatchObject({ worktreeIds: [], loaded: false })
    unmount()
  })

  it('keeps a confirmed list that equals the first page through a later failed poll', async () => {
    const { seen, settleFull, unmount } = await mountCatalog()
    let fetching: Promise<void> = Promise.resolve()
    await act(async () => {
      fetching = seen.fetch()
    })
    await act(async () => {
      settleFull(reply({ worktrees: [row('pinned')], snapshotId: 's1' }))
      await fetching
    })
    await act(async () => {
      fetching = seen.fetch()
    })
    await act(async () => {
      settleFull(new Error('network disconnected'))
      await fetching
    })
    expect(seen).toMatchObject({ worktreeIds: ['pinned'], loaded: true })
    unmount()
  })

  it('does not draw a first page that lands after the full read failed', async () => {
    const { seen, settleFull, settleFirstPage, unmount } = await mountCatalog({
      deferFirstPage: true
    })
    let fetching: Promise<void> = Promise.resolve()
    await act(async () => {
      fetching = seen.fetch()
    })
    await act(async () => {
      settleFull(new Error('network disconnected'))
      await fetching
    })
    await act(async () => {
      settleFirstPage()
    })
    expect(seen).toMatchObject({ worktreeIds: [], loaded: false })
    unmount()
  })
})
