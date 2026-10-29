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

async function fetchWith(fail: boolean) {
  const client = new FakeSession('connected')
  const response: RpcResponse = {
    id: 'r',
    ok: true,
    result: { worktrees: [], snapshotId: 's1' },
    _meta: { runtimeId: 'runtime' }
  }
  client.sendRequest.mockImplementation(async () => {
    if (fail) {
      throw new Error('network disconnected')
    }
    return response
  })
  let current: { state: ReturnType<typeof useHostScreenState>; fetch: () => Promise<void> } | null =
    null
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
    current = { state, fetch: catalog.fetchWorktrees }
    return null
  }
  let renderer: ReturnType<typeof create> | null = null
  try {
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    const get = (): NonNullable<typeof current> => {
      if (current === null) {
        throw new Error('catalog hook did not mount')
      }
      return current
    }
    act(() => get().state.setActionError('Could not delete workspace.'))
    await act(async () => get().fetch())
    expect(client.sendRequest).toHaveBeenCalledWith('worktree.ps', expect.anything())
    return {
      actionError: get().state.actionError,
      catalogError: get().state.catalogError,
      loaded: get().state.worktreesLoaded
    }
  } finally {
    act(() => renderer?.unmount())
  }
}

describe('a catalog the host confirmed', () => {
  it('clears the action failure the list is still showing', async () => {
    expect(await fetchWith(false)).toEqual({ actionError: '', catalogError: null, loaded: true })
  })
  it('retains the action failure when the catalog transport fails', async () => {
    expect(await fetchWith(true)).toMatchObject({
      actionError: 'Could not delete workspace.',
      catalogError: 'network_error'
    })
  })
})
