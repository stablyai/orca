// Model newer-desktop manifest routes as data: this tree’s build forbids declarations without modules, so same-tree fixtures cannot represent that mixed-version state.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: (string | undefined)[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  routes: [],
  refusals: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: (props: { hostId: string | undefined }) => {
    dependencies.refusals.push(props.hostId)
    return null
  }
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: {
    route: { pathname: string; params?: Record<string, string> }
  }) => {
    dependencies.routes.push(props.route)
    return null
  }
}))

import { BRIDGE_MAX_ROUTE_PARAMS, BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import { grantsForRoute, matchesRoutePattern, routeViewOf } from './page-route-policy'
import { shellScreenRouteKey } from './shell-screen-route'
import MobileWebPageCatchAllScreen from './catch-all-page-route'

function servesRoute(routes: Parameters<typeof routeViewOf>[0], pathname: string): boolean {
  return routeViewOf(routes, pathname).pageRoutes.some((pattern) =>
    matchesRoutePattern(pathname, pattern)
  )
}

async function render(): Promise<void> {
  await act(async () => {
    create(createElement(MobileWebPageCatchAllScreen))
  })
}

beforeEach(() => {
  dependencies.routes.length = 0
  dependencies.refusals.length = 0
  dependencies.params = { hostId: 'host-1', page: ['settings'] }
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

  it('refuses a pathname with no segment past the host', async () => {
    dependencies.params = { hostId: 'host-1', page: [] }
    await render()
    expect(dependencies.routes).toEqual([])
    expect([...new Set(dependencies.refusals)]).toEqual(['host-1'])
  })

  it("carries the deep link's query through to the route it mounts the shell on", async () => {
    dependencies.params = { hostId: 'host-1', page: ['session', 'wt-1'], tab: 'files' }
    await render()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/session/wt-1', params: { tab: 'files' } }
    ])
  })

  it('omits the params key when the deep link carried no query', async () => {
    // Omit absent query params to preserve route identity and avoid a trailing question mark in page history.
    dependencies.params = { hostId: 'host-1', page: ['settings'] }
    await render()
    expect(dependencies.routes[0]).not.toHaveProperty('params')
  })

  it('keeps a key the deep link gave no value, which is not the same as no key', async () => {
    // Preserve empty values: unlike named routes, the catch-all cannot know another screen’s meaning for them.
    dependencies.params = { hostId: 'host-1', page: ['settings'], tab: '' }
    await render()
    expect(dependencies.routes[0]?.params).toEqual({ tab: '' })
  })

  it('takes the first value of a repeated query key, not the joined array', async () => {
    // Use firstParam per key; init carries one string and array coercion would send a,b.
    dependencies.params = { hostId: 'host-1', page: ['settings'], tab: ['files', 'diff'] }
    await render()
    expect(dependencies.routes[0]?.params).toEqual({ tab: 'files' })
  })

  it('carries a value needing encoding decoded, and re-encodes it into the page url', async () => {
    dependencies.params = { hostId: 'host-1', page: ['files'], q: 'a b&c=d/e' }
    await render()
    const route = dependencies.routes[0]
    expect(route?.params).toEqual({ q: 'a b&c=d/e' })
    expect(route && shellScreenRouteKey(route)).toBe('/h/host-1/files?q=a+b%26c%3Dd%2Fe')
  })

  it('drops the fragment expo-router parks under `#`, which is not a query', async () => {
    // Expo seeds # from the fragment; it is not a query param to forward.
    dependencies.params = { hostId: 'host-1', page: ['session', 'wt-1'], '#': 'files' }
    await render()
    expect(dependencies.routes[0]).not.toHaveProperty('params')
  })

  it('keeps the rest of the query when a fragment rides along with it', async () => {
    dependencies.params = { hostId: 'host-1', page: ['session', 'wt-1'], '#': 'files', tab: 'diff' }
    await render()
    expect(dependencies.routes[0]?.params).toEqual({ tab: 'diff' })
  })

  it('refuses a deep link carrying more params than the bridge will take', async () => {
    // Refuse oversized route state instead of opening a screen with silently dropped params.
    dependencies.params = {
      hostId: 'host-1',
      page: ['settings'],
      ...Object.fromEntries(
        Array.from({ length: BRIDGE_MAX_ROUTE_PARAMS + 1 }, (_, index) => [`k${index}`, 'v'])
      )
    }
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
    expect(servesRoute(FUTURE_MANIFEST, '/h/H1/insights')).toBe(true)
    expect(servesRoute(FUTURE_MANIFEST, '/h/H1/insights/W1')).toBe(true)
    expect(grantsForRoute(FUTURE_MANIFEST, '/h/H1/insights/W1')).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'haptics'
    ])
  })

  it('refuses a pathname the manifest does not list', () => {
    expect(servesRoute(FUTURE_MANIFEST, '/h/H1/settings')).toBe(false)
    expect(grantsForRoute(FUTURE_MANIFEST, '/h/H1/settings')).toEqual([])
  })

  it('refuses a listed route needing a grant this app does not implement', () => {
    expect(servesRoute(FUTURE_MANIFEST, '/h/H1/future')).toBe(false)
    expect(routeViewOf(FUTURE_MANIFEST, '/h/H1/future').pageRoutes).toEqual([
      '/h/[hostId]/insights',
      '/h/[hostId]/insights/[worktreeId]'
    ])
  })
})
