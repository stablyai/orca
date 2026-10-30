import { createElement, type EffectCallback } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCatalogEntry } from '../transport/types'

type HomeProbe = {
  home: { hosts: HostCatalogEntry[]; onOpen: (host: HostCatalogEntry) => void } | null
  order: { onReorder: (ids: string[]) => void } | null
  load: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  focus: EffectCallback | null
  router: { push: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> }
  connections: { allClients: unknown[]; hostStates: Record<string, 'connected' | 'disconnected'> }
}
const probe = vi.hoisted((): HomeProbe => ({
  home: null,
  order: null,
  load: vi.fn(),
  save: vi.fn(),
  focus: null,
  router: { push: vi.fn(), replace: vi.fn() },
  connections: { allClients: [], hostStates: {} }
}))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useRouter: () => probe.router,
    useFocusEffect: (callback: EffectCallback) => {
      probe.focus = callback
      React.useEffect(callback, [callback])
    }
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null }
}))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: probe.load,
  reorderHosts: probe.save
}))
vi.mock('./use-mobile-home-host-connections', () => ({
  useMobileHomeHostConnections: () => probe.connections
}))
vi.mock('../components/AccountUsage', () => ({ hasRenderableUsage: () => false }))
vi.mock('../cache/home-snapshot-cache', () => ({
  loadHomeSnapshot: async () => null,
  saveHomeSnapshot: vi.fn()
}))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  getProvenCachedWorktrees: () => null,
  setCachedWorktrees: vi.fn()
}))
vi.mock('../onboarding/mobile-onboarding-plan', () => ({
  loadMobileOnboardingSteps: async () => [],
  mobileOnboardingDestination: () => '/index'
}))
vi.mock('../stats/home-stats-total', () => ({ totalHomeStats: () => null }))
vi.mock('../worktree/home-resume-card', () => ({
  selectHomeResumeCard: () => null,
  isResumeTargetConfirmedMissing: () => false
}))
vi.mock('../worktree/home-host-worktree-fetch', () => ({ fetchHomeHostWorktreeInfo: vi.fn() }))
vi.mock('./mobile-home-host-requests', () => ({
  fetchMobileHomeAccounts: vi.fn(),
  fetchMobileHomeStats: vi.fn(),
  fetchMobileHomeTaskProviders: vi.fn()
}))

import { orderHostsByIds } from '../transport/host-list-order'
import { useMobileHomeData } from './use-mobile-home-data'

function desktop(id: string, lastConnected: number): HostCatalogEntry {
  const profile = {
    id,
    name: id,
    endpoint: 'ws://127.0.0.1:1',
    deviceToken: 'fixture-token',
    publicKeyB64: id,
    lastConnected
  }
  return { ...profile, profile, credentialStatus: 'ready' }
}
let catalog: HostCatalogEntry[]
beforeEach(() => {
  vi.clearAllMocks()
  catalog = [desktop('a', 1), desktop('b', 100)]
  probe.connections.hostStates = { a: 'disconnected', b: 'connected' }
  probe.load.mockImplementation(async () => catalog)
  probe.save.mockImplementation(async (ids: string[]) => {
    catalog = orderHostsByIds(catalog, ids)
  })
})

async function mounted() {
  let value: ReturnType<typeof useMobileHomeData>
  function Harness() {
    value = useMobileHomeData()
    return null
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(createElement(Harness))
  })
  return {
    get value() {
      return value!
    },
    root: root!,
    rerender: async () => {
      await act(async () => root!.update(createElement(Harness)))
    }
  }
}

describe('home desktop order', () => {
  it('uses durable order regardless of recency or live connection status', async () => {
    const fixture = await mounted()
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['a', 'b'])
    probe.connections.hostStates = { a: 'connected', b: 'disconnected' }
    await fixture.rerender()
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['a', 'b'])
    catalog = [desktop('a', 500), desktop('b', 0)]
    await act(async () => {
      probe.focus!()
    })
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['a', 'b'])
    await act(async () => fixture.root.unmount())
  })

  it('keeps a dropped order through focus and a fresh mount', async () => {
    const fixture = await mounted()
    await act(async () => fixture.value.reorderHostCatalog(['b', 'a']))
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['b', 'a'])
    await act(async () => {
      probe.focus!()
    })
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['b', 'a'])
    await act(async () => fixture.root.unmount())
    const remounted = await mounted()
    expect(remounted.value.sortedHostCatalog.map((host) => host.id)).toEqual(['b', 'a'])
    await act(async () => remounted.root.unmount())
  })

  it('does not let an older focus read overwrite a completed reorder', async () => {
    const fixture = await mounted()
    const stale = catalog
    let resolve: (value: HostCatalogEntry[]) => void
    probe.load.mockImplementationOnce(
      () =>
        new Promise<HostCatalogEntry[]>((done) => {
          resolve = done
        })
    )
    await act(async () => {
      probe.focus!()
    })
    await act(async () => fixture.value.reorderHostCatalog(['b', 'a']))
    await act(async () => resolve!(stale))
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['b', 'a'])
    await act(async () => fixture.root.unmount())
  })

  it('restores the saved order and reports persistence failure', async () => {
    const fixture = await mounted()
    probe.save.mockRejectedValueOnce(new Error('storage unavailable'))
    await act(async () => {
      await expect(fixture.value.reorderHostCatalog(['b', 'a'])).rejects.toThrow(
        'storage unavailable'
      )
    })
    expect(fixture.value.sortedHostCatalog.map((host) => host.id)).toEqual(['a', 'b'])
    await act(async () => fixture.root.unmount())
  })
})

// Render the real screen and data hook: the credential check used a different load path than focus.
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'safe-area',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('../theme/mobile-theme', () => ({ colors: { bgBase: '#000000' } }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, contentMaxWidth: 400 })
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../accounts/use-open-mobile-accounts', () => ({ useOpenMobileAccounts: () => vi.fn() }))
vi.mock('../session/use-open-mobile-session', () => ({ useOpenMobileSession: () => vi.fn() }))
vi.mock('../tasks/use-open-mobile-tasks', () => ({ useOpenMobileTasks: () => vi.fn() }))
vi.mock('../transport/use-open-mobile-host-edit', () => ({ useOpenMobileHostEdit: () => vi.fn() }))
vi.mock('../transport/client-context', () => ({
  useDisconnectHostClient: () => vi.fn(),
  useForgetHostClient: () => vi.fn(),
  useForceReconnect: () => vi.fn()
}))
vi.mock('../host-list-action-sheet-actions', () => ({ getHostListActionSheetActions: () => [] }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: () => null }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileHomeEmptyState', () => ({ MobileHomeEmptyState: () => null }))
vi.mock('./MobileHomeTopBar', () => ({ MobileHomeTopBar: () => null }))
vi.mock('./MobileHomeListFooter', () => ({ MobileHomeListFooter: () => null }))
vi.mock('./MobileHomeHostList', () => ({
  MobileHomeHostList: (props: NonNullable<typeof probe.home>) => {
    probe.home = props
    return null
  }
}))
vi.mock('./MobileHomeHostOrderDrawer', () => ({
  MobileHomeHostOrderDrawer: (props: NonNullable<typeof probe.order>) => {
    probe.order = props
    return null
  }
}))

import { MobileHomeScreen } from './MobileHomeScreen'

it('keeps a completed drag when an older pairing recheck finishes', async () => {
  catalog[0] = { ...catalog[0], profile: null, credentialStatus: 'temporarily-unavailable' }
  const stale = catalog
  let root: ReturnType<typeof create> | undefined
  try {
    await act(async () => {
      root = create(createElement(MobileHomeScreen))
    })
    let resolve: (value: HostCatalogEntry[]) => void
    probe.load.mockImplementationOnce(
      () =>
        new Promise<HostCatalogEntry[]>((done) => {
          resolve = done
        })
    )
    await act(async () => {
      probe.home!.onOpen(stale[0])
    })
    await act(async () => {
      probe.order!.onReorder(['b', 'a'])
    })
    expect(probe.home!.hosts.map((host) => host.id)).toEqual(['b', 'a'])
    await act(async () => {
      resolve!(stale)
    })
    expect(probe.home!.hosts.map((host) => host.id)).toEqual(['b', 'a'])
  } finally {
    if (root) {
      await act(async () => root!.unmount())
    }
  }
})

vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: vi.fn() }))

it('keeps the newer pairing result when an earlier focus read finishes last', async () => {
  catalog[0] = { ...catalog[0], profile: null, credentialStatus: 'temporarily-unavailable' }
  const stale = catalog
  let root: ReturnType<typeof create> | undefined
  try {
    await act(async () => {
      root = create(createElement(MobileHomeScreen))
    })
    let resolve: (value: HostCatalogEntry[]) => void
    probe.load.mockImplementationOnce(
      () =>
        new Promise<HostCatalogEntry[]>((done) => {
          resolve = done
        })
    )
    await act(async () => {
      probe.focus!()
    })
    catalog = [{ ...desktop('a', 1), name: 'Updated A' }, desktop('b', 100)]
    await act(async () => {
      probe.home!.onOpen(stale[0])
    })
    expect(probe.home!.hosts[0].name).toBe('Updated A')
    await act(async () => {
      resolve!(stale)
    })
    expect(probe.home!.hosts[0].name).toBe('Updated A')
  } finally {
    if (root) {
      await act(async () => root!.unmount())
    }
  }
})

it('applies a current pairing recheck and preserves the catalog when the next check fails', async () => {
  catalog[0] = { ...catalog[0], profile: null, credentialStatus: 'temporarily-unavailable' }
  const unavailable = catalog[0]
  let root: ReturnType<typeof create> | undefined
  try {
    await act(async () => {
      root = create(createElement(MobileHomeScreen))
    })
    catalog = [desktop('a', 1), desktop('b', 100)]
    await act(async () => {
      probe.home!.onOpen(unavailable)
    })
    expect(probe.home!.hosts[0].credentialStatus).toBe('ready')
    probe.load.mockRejectedValueOnce(new Error('temporary read failure'))
    await act(async () => {
      probe.home!.onOpen(unavailable)
    })
    expect(probe.home!.hosts[0].credentialStatus).toBe('ready')
    expect(probe.home!.hosts.map((host) => host.id)).toEqual(['a', 'b'])
    const { Alert } = await import('react-native')
    expect(Alert.alert).toHaveBeenCalledWith('Could not check pairing', 'Please try again.')
  } finally {
    if (root) {
      await act(async () => root!.unmount())
    }
  }
})
