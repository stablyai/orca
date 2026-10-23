import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { useHostScreenState } from './use-host-screen-state'
import { useHostViewSettings } from './use-host-view-settings'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

/** The desktop holds `recent` and nothing collapsed; the first of each write is lost in transit. */
function desktop() {
  const client = new FakeSession('connected')
  const lost = new Set<string>()
  const writes: string[] = []
  client.sendRequest.mockImplementation(async (method: string) => {
    if (method === 'ui.set' || method === 'ui.setCollapsed') {
      writes.push(method)
      if (!lost.has(method)) {
        lost.add(method)
        throw new Error('client_disconnected')
      }
      return reply(method === 'ui.set' ? { ui: {} } : { collapsed: true, applied: true })
    }
    if (method === 'ui.get') {
      return reply({ ui: { sortBy: 'recent', collapsedGroups: [] } })
    }
    if (method === 'worktree.ps') {
      return reply({ worktrees: [], snapshotId: 's1' })
    }
    return reply({})
  })
  return { client, writes }
}

// The feed's own reads are not under test; it only replaces the poll, as on a switched-on page.
const SIDEBAR_FEED = { refresh: () => {}, changed: () => {}, onInstalled: () => () => {} }
// Stable across renders, as the screen's own are: each is a dependency of the refresh lifecycle.
const NO_CAPABILITIES: string[] = []
const fetchRepoMetadata = async (): Promise<void> => {}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function mountScreen(client: FakeSession) {
  const held: { view?: ReturnType<typeof useHostViewSettings> } = {}
  function Probe({ connState }: { connState: ConnectionState }): null {
    const state = useHostScreenState('host-1')
    state.clientRef.current = client
    const view = useHostViewSettings({ client, connState, state })
    held.view = view
    useHostWorktreeCatalog({
      client,
      connState,
      embedded: true,
      fetchRepoMetadata,
      hostCapabilities: NO_CAPABILITIES,
      hostId: 'host-1',
      sidebarFeed: SIDEBAR_FEED,
      state,
      syncViewSettingsFromDesktop: view.syncViewSettingsFromDesktop
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe, { connState: 'connected' }))
  })
  return {
    view: () => held.view!,
    connect: async (connState: ConnectionState) => {
      await act(async () => {
        renderer!.update(createElement(Probe, { connState }))
      })
    }
  }
}

describe('Workspace options changed while the connection drops', () => {
  it('resends a sort and a collapse the desktop never got once the phone reconnects', async () => {
    const { client, writes } = desktop()
    const screen = await mountScreen(client)
    await act(async () => {
      screen.view().handleSortChange('name')
      screen.view().toggleCollapsed('repo:orca')
    })
    expect(screen.view().pendingViewChanges.pending).toHaveLength(2)

    await screen.connect('reconnecting')
    await screen.connect('connected')

    expect(writes).toEqual(['ui.set', 'ui.setCollapsed', 'ui.set', 'ui.setCollapsed'])
    expect(screen.view().pendingViewChanges.pending).toEqual([])
  })
})
