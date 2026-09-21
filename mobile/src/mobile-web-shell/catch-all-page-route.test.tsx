/**
 * The catch-all switch, which is the one with no native screen behind it.
 *
 * A manifest route this app has no route file for is a cross-version state and cannot exist in one
 * tree: the page bundle and the native app are built from the same `app/h/**`, and the build fails
 * a declaration it has no module for. So the manifest half is driven as data through
 * `page-route-policy`, and this file pins what the switch hands it.
 */
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: (string | undefined)[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  routes: [],
  refusals: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: (props: { hostId: string | undefined }) => {
    dependencies.refusals.push(props.hostId)
    return null
  }
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: { route: { pathname: string } }) => {
    dependencies.routes.push(props.route)
    return null
  }
}))

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import { grantsForRoute, pageRendersRoute, routeViewOf } from './page-route-policy'
import MobileWebPageCatchAllScreen from './catch-all-page-route'

async function render(): Promise<void> {
  await act(async () => {
    create(createElement(MobileWebPageCatchAllScreen))
  })
}

beforeEach(() => {
  dependencies.storage.clear()
  dependencies.routes.length = 0
  dependencies.refusals.length = 0
  dependencies.params = { hostId: 'host-1', page: ['settings'] }
  Object.assign(globalThis, { __DEV__: true })
  dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
})

describe('the catch-all switch', () => {
  it('opens the shell on the pathname it was reached by', async () => {
    await render()
    expect(dependencies.routes).toEqual([{ pathname: '/h/host-1/settings' }])
  })

  it('rebuilds a multi-segment pathname the bridge rule accepts', async () => {
    dependencies.params = { hostId: 'host-1', page: ['a', 'b', 'c'] }
    await render()
    const pathname = dependencies.routes[0]?.pathname ?? ''
    expect(pathname).toBe('/h/host-1/a/b/c')
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname)).toBe(true)
  })

  it('re-encodes each segment expo-router handed back decoded', async () => {
    dependencies.params = { hostId: 'host 1', page: ['a b', 'c?d'] }
    await render()
    const pathname = dependencies.routes[0]?.pathname ?? ''
    expect(pathname).toBe('/h/host%201/a%20b/c%3Fd')
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname)).toBe(true)
  })

  it('takes the first value of a repeated host id, not the joined array', async () => {
    dependencies.params = { hostId: ['host-a', 'host-b'], page: ['settings'] }
    await render()
    expect(dependencies.routes[0]?.pathname).toBe('/h/host-a/settings')
  })

  it('refuses rather than falling back to a native screen it does not have', async () => {
    dependencies.params = { hostId: 'host-1', page: [] }
    await render()
    expect(dependencies.routes).toEqual([])
    // Twice: once before the flag read settles and once after, both on the refusal.
    expect([...new Set(dependencies.refusals)]).toEqual(['host-1'])
  })

  it('refuses while the flag read is still settling', async () => {
    dependencies.storage.clear()
    await render()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.refusals.length).toBeGreaterThan(0)
  })

  it('refuses a dot-segment host id the bridge rule would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, page: ['settings'] }
      dependencies.routes.length = 0
      await render()
      expect(dependencies.routes).toEqual([])
    }
  })
})

/**
 * The manifest half, as a desktop newer than this app would send it: two routes whose files this
 * app does not have, and one declaring a grant it does not implement.
 */
const FUTURE_MANIFEST = [
  { pathname: '/h/[hostId]/insights', grants: ['navigate', 'storage', 'haptics'] },
  {
    pathname: '/h/[hostId]/insights/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  { pathname: '/h/[hostId]/future', grants: ['navigate', 'storage', 'haptics', 'native.nope'] }
]

describe('the gate a catch-all pathname meets', () => {
  it('renders a manifest route this app has no route file for', () => {
    expect(pageRendersRoute(FUTURE_MANIFEST, '/h/H1/insights')).toBe(true)
    expect(pageRendersRoute(FUTURE_MANIFEST, '/h/H1/insights/W1')).toBe(true)
    expect(grantsForRoute(FUTURE_MANIFEST, '/h/H1/insights/W1')).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'haptics'
    ])
  })

  it('refuses a pathname the manifest does not list', () => {
    expect(pageRendersRoute(FUTURE_MANIFEST, '/h/H1/settings')).toBe(false)
    expect(grantsForRoute(FUTURE_MANIFEST, '/h/H1/settings')).toEqual([])
  })

  it('refuses a listed route needing a grant this app does not implement', () => {
    expect(pageRendersRoute(FUTURE_MANIFEST, '/h/H1/future')).toBe(false)
    expect(routeViewOf(FUTURE_MANIFEST, '/h/H1/future').pageRoutes).toEqual([
      '/h/[hostId]/insights',
      '/h/[hostId]/insights/[worktreeId]'
    ])
  })
})
