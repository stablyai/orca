import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

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
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

function settingsReply(settings: unknown): RpcResponse {
  return { id: 'reply', ok: true, result: { settings }, _meta: { runtimeId: 'runtime' } }
}

const noop = () => {}

type ClientRef = { current: RpcClient | null }

function screenState(clientRef: ClientRef, applied: boolean[]) {
  return {
    clientRef,
    fetchWorktreesInFlightRef: { current: false },
    newWorktreeModalVisibleRef: { current: false },
    repoMetadataFetchedAtRef: { current: 0 },
    worktreeCatalogRef: { current: null },
    setShowPinnedInGroups: (show: boolean) => applied.push(show),
    ...Object.fromEntries(
      [
        'setActionError',
        'setCatalogError',
        'setError',
        'setHostLabelById',
        'setHostHealthById',
        'setHostName',
        'setHostPlatform',
        'setHostStoredDescriptor',
        'setLastKnownWorktrees',
        'setOptimisticActiveWorktreeIdentity',
        'setPinnedIds',
        'setRepoColorsByName',
        'setRepoHostIdByRepoId',
        'setRepoIconsByName',
        'setSleptIds',
        'setWorktrees',
        'setWorktreesLoaded'
      ].map((setter) => [setter, noop])
    )
  }
}

// Mounting the embedded catalog runs its refresh, which issues the placement read.
async function refreshWith(
  reply: Promise<RpcResponse>,
  onSent: (clientRef: ClientRef) => void = noop
): Promise<boolean[]> {
  const client = new FakeSession('connected')
  const clientRef: ClientRef = { current: client }
  client.sendRequest.mockImplementation(() => {
    onSent(clientRef)
    return reply
  })
  const applied: boolean[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mount-time refresh reads clientRef and setShowPinnedInGroups; the other members are inert stubs.
  const args = {
    client,
    connState: 'connected',
    embedded: true,
    fetchRepoMetadata: async () => {},
    hostId: 'host-1',
    state: screenState(clientRef, applied),
    syncViewSettingsFromDesktop: async () => {}
  } as unknown as Parameters<typeof useHostWorktreeCatalog>[0]
  function Probe(): null {
    useHostWorktreeCatalog(args)
    return null
  }
  await act(async () => {
    create(createElement(Probe))
    await reply.catch(noop)
  })
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual(['settings.get'])
  return applied
}

describe('the host list mirrors the desktop pinned-placement setting', () => {
  it('applies the setting the host reports on refresh, absent reading as off', async () => {
    const on = settingsReply({ showPinnedWorktreesInGroups: true })
    expect(await refreshWith(Promise.resolve(on))).toEqual([true])
    expect(await refreshWith(Promise.resolve(settingsReply({})))).toEqual([false])
  })

  it('drops a reply that lands after the screen moved to another client', async () => {
    const on = settingsReply({ showPinnedWorktreesInGroups: true })
    const moveOn = (clientRef: ClientRef) => {
      clientRef.current = new FakeSession('connected')
    }
    expect(await refreshWith(Promise.resolve(on), moveOn)).toEqual([])
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
