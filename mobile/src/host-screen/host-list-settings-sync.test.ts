import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({
  loadPinnedIds: async () => new Set(),
  savePinnedIds: async () => {}
}))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [],
  updateLastConnected: async () => {}
}))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import type { RpcClient } from '../transport/rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useHostScreenIdentity } from './use-host-screen-identity'
import { useHostViewSettings } from './use-host-view-settings'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const noop = () => {}

type ClientRef = { current: RpcClient | null }

function screenState(clientRef: ClientRef, applied: boolean[]) {
  const viewRef = { current: INITIAL_MOBILE_VIEW }
  return {
    clientRef,
    viewRef,
    repoMetadataFetchedAtRef: { current: 0 },
    setView: (view: MobileViewState) => {
      viewRef.current = view
    },
    setShowPinnedInGroups: (show: boolean) => applied.push(show),
    ...Object.fromEntries(
      [
        'setCatalogError',
        'setDesktopRepos',
        'setError',
        'setHostLabelById',
        'setHostHealthById',
        'setHostName',
        'setHostPlatform',
        'setHostStoredDescriptor',
        'setLastKnownWorktrees',
        'setPinnedIds',
        'setRepoHostIdByRepoId',
        'setServedProjectSections',
        'setWorktrees',
        'setWorktreesLoaded'
      ].map((setter) => [setter, noop])
    )
  }
}

type Actions = ReturnType<typeof useHostViewSettings>

// One view sync: ui.get and settings.get go out together; `failing` rejects one of them.
async function syncWith(
  settings: unknown,
  options: {
    failing?: 'ui.get' | 'settings.get'
    onSent?: (clientRef: ClientRef, actions: Actions) => void
  } = {}
): Promise<{ applied: boolean[]; view: MobileViewState; methods: string[] }> {
  const client = new FakeSession('connected')
  const clientRef: ClientRef = { current: client }
  let actions: Actions | null = null
  client.sendRequest.mockImplementation(async (method: string) => {
    if (method === options.failing) {
      throw new Error('transport closed')
    }
    if (method === 'ui.set') {
      return reply(null)
    }
    options.onSent?.(clientRef, actions!)
    return method === 'settings.get' ? reply({ settings }) : reply({ ui: { groupBy: 'none' } })
  })
  const applied: boolean[] = []
  const state = screenState(clientRef, applied)
  function Probe(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view sync reads only the refs and setters screenState provides.
    const hostState = state as unknown as Parameters<typeof useHostViewSettings>[0]['state']
    actions = useHostViewSettings({ client, connState: 'connected', state: hostState })
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    await actions!.syncViewSettingsFromDesktop()
  })
  return {
    applied,
    view: state.viewRef.current,
    methods: client.sendRequest.mock.calls
      .map(([method]) => String(method))
      .filter((method) => method !== 'ui.set')
      .sort()
  }
}

const ALL_ON = {
  showPinnedWorktreesInGroups: true,
  compactWorktreeCards: true,
  experimentalNewWorktreeCardStyle: true
}

describe('the host list mirrors the desktop list settings', () => {
  it('reads them with one settings.get beside ui.get, absent reading as off', async () => {
    const on = await syncWith(ALL_ON)
    expect(on.methods).toEqual(['settings.get', 'ui.get'])
    expect(on.applied).toEqual([true])
    expect(on.view).toMatchObject({
      groupBy: 'none',
      compactWorktreeCards: true,
      newCardStyle: true
    })
    const off = await syncWith({})
    expect(off.applied).toEqual([false])
    expect(off.view).toMatchObject({ compactWorktreeCards: false, newCardStyle: false })
  })

  it('drops a reply that lands after the screen moved to another client', async () => {
    const moveOn = (clientRef: ClientRef) => {
      clientRef.current = new FakeSession('connected')
    }
    const moved = await syncWith(ALL_ON, { onSent: moveOn })
    expect(moved.applied).toEqual([])
    expect(moved.view).toBe(INITIAL_MOBILE_VIEW)
  })

  it('applies each read on its own when the other fails', async () => {
    const noUi = await syncWith(ALL_ON, { failing: 'ui.get' })
    expect(noUi.applied).toEqual([true])
    expect(noUi.view).toMatchObject({ groupBy: 'repo', compactWorktreeCards: true })
    const noSettings = await syncWith(ALL_ON, { failing: 'settings.get' })
    expect(noSettings.applied).toEqual([])
    expect(noSettings.view).toMatchObject({ groupBy: 'none', compactWorktreeCards: false })
  })

  it('keeps a local edit made during the read, while pinned placement still applies', async () => {
    const edited = await syncWith(ALL_ON, {
      onSent: (_clientRef, actions) => actions.handleSortChange('name')
    })
    expect(edited.applied).toEqual([true])
    expect(edited.view).toMatchObject({
      sortBy: 'name',
      groupBy: 'repo',
      compactWorktreeCards: false,
      newCardStyle: false
    })
  })

  it('resets to off when the screen is reused for another host', async () => {
    const applied: boolean[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the identity hook reads only the refs and setters screenState provides.
    const identityState = screenState({ current: null }, applied) as unknown as Parameters<
      typeof useHostScreenIdentity
    >[0]['state']
    function Probe({ hostId }: { hostId: string }): null {
      useHostScreenIdentity({ client: null, hostId, state: identityState })
      return null
    }
    const renderer = create(createElement(Probe, { hostId: 'host-1' }))
    await act(async () => {})
    applied.length = 0
    await act(async () => {
      renderer.update(createElement(Probe, { hostId: 'host-2' }))
    })
    expect(applied).toEqual([false])
  })
})

describe('Card layout from the phone', () => {
  async function chooseCompact(settingsReply: RpcResponse) {
    const client = new FakeSession('connected')
    const clientRef: ClientRef = { current: client }
    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'settings.update' ? settingsReply : reply(null)
    )
    const state = screenState(clientRef, [])
    let actions: Actions | null = null
    function Probe(): null {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the refs and setters screenState provides.
      const hostState = state as unknown as Parameters<typeof useHostViewSettings>[0]['state']
      actions = useHostViewSettings({ client, connState: 'connected', state: hostState })
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })
    await act(async () => {
      actions!.setCardLayout('compact')
    })
    return {
      view: state.viewRef.current,
      calls: client.sendRequest.mock.calls.map(([method, params]) => ({ method, params }))
    }
  }

  it('writes the setting first, then the matching preset once the host accepts it', async () => {
    const { view, calls } = await chooseCompact(reply({ settings: {} }))
    expect(calls.map(({ method }) => method)).toEqual(['settings.update', 'ui.set'])
    expect(calls[1]?.params).toEqual({
      worktreeCardProperties: ['status'],
      _worktreeCardModeDefaulted: true
    })
    expect(view).toMatchObject({ compactWorktreeCards: true, worktreeCardProperties: ['status'] })
  })

  it('leaves the preset and the phone alone when the host refuses the setting', async () => {
    const refused: RpcResponse = {
      id: 'reply',
      ok: false,
      error: { code: 'runtime_error', message: 'refused' },
      _meta: { runtimeId: 'runtime' }
    }
    const { view, calls } = await chooseCompact(refused)
    expect(calls.map(({ method }) => method)).toEqual(['settings.update'])
    expect(view).toBe(INITIAL_MOBILE_VIEW)
  })
})
