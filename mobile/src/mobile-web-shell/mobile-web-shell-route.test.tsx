import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  mounted: string[]
  /** The pathname each mount was told to open, which is the only thing the page can route on. */
  pathnames: string[]
  hostId: string
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  mounted: [],
  pathnames: [],
  hostId: 'host-1'
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => ({ hostId: dependencies.hostId })
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: { hostId: string; route: { pathname: string } }) => {
    dependencies.mounted.push(props.hostId)
    dependencies.pathnames.push(props.route.pathname)
    return null
  }
}))

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import MobileWebShellRoute from '../../app/h/[hostId]/web'

/** Host elements are matched by name, not by `findAllByType`: React's `ElementType` does not admit
 *  an arbitrary React Native host name, so the typed form is a predicate. */
function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

async function renderRoute(): Promise<ReactTestRenderer> {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebShellRoute))
  })
  if (rendered.tree === null) {
    throw new Error('route did not render')
  }
  return rendered.tree
}

/** `__DEV__` is a React Native global, absent outside that runtime; assigned rather than cast so
 *  the test says which build kind it is running as without asserting a type on `globalThis`. */
function setDevelopmentBuild(isDevelopmentBuild: boolean | undefined): void {
  if (isDevelopmentBuild === undefined) {
    Reflect.deleteProperty(globalThis, '__DEV__')
    return
  }
  Object.assign(globalThis, { __DEV__: isDevelopmentBuild })
}

describe('the hybrid shell route', () => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.mounted.length = 0
    dependencies.pathnames.length = 0
    dependencies.hostId = 'host-1'
    setDevelopmentBuild(true)
  })

  it('redirects to the host screen with the flag unset, and mounts nothing', async () => {
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect').map((node) => node.props.href)).toEqual(['/h/host-1'])
    expect(dependencies.mounted).toEqual([])
  })

  it('redirects with the flag explicitly off', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'false')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toHaveLength(1)
    expect(dependencies.mounted).toEqual([])
  })

  it('mounts the shell screen for this host with the flag on', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toEqual([])
    expect(dependencies.mounted).toEqual(['host-1'])
  })

  it('encodes the host id into the pathname, so no host id can bend the route', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    // Every shape the bridge's pathname rule refuses, reached through a host id the app will
    // happily route to: a query, a fragment, whitespace, a separator and a backslash.
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      await renderRoute()
      const pathname = dependencies.pathnames[0]
      expect(pathname, hostId).toBe(`/h/${encodeURIComponent(hostId)}`)
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname ?? ''), hostId).toBe(true)
      // And it still names the host it was opened for.
      expect(decodeURIComponent((pathname ?? '').slice('/h/'.length)), hostId).toBe(hostId)
    }
  })

  it('cannot encode a dot-segment host id away, and does not pretend to', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    dependencies.hostId = '..'
    await renderRoute()
    // `encodeURIComponent` leaves a dot alone, and percent-escaping one would not help either: the
    // URL parser treats `%2e%2e` as a dot segment too. So this one reaches the bridge as a route
    // the pattern refuses, and the host is what turns it into a failure screen rather than a blank
    // WebView. Deep links are the way in, which is why it is worth having a verdict for.
    expect(dependencies.pathnames).toEqual(['/h/..'])
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test('/h/..')).toBe(false)
  })

  it('redirects a store build whose container kept a flag a development build set', async () => {
    setDevelopmentBuild(undefined)
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toHaveLength(1)
    expect(dependencies.mounted).toEqual([])
  })

  it('neither redirects nor mounts until the flag has been read', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    // No `await` inside act: the effect's promise is deliberately left unsettled.
    act(() => {
      rendered.tree = create(createElement(MobileWebShellRoute))
    })
    const tree = rendered.tree
    expect(tree === null ? [] : byName(tree, 'Redirect')).toEqual([])
    expect(dependencies.mounted).toEqual([])
    // The neutral state itself, rendered for real here: `shell-switch-null-flag.test.tsx` mocks it
    // to count mounts across all nine switches, so this is where its shape stays pinned.
    expect(tree === null ? [] : byName(tree, 'ActivityIndicator')).toHaveLength(1)
    await act(async () => {})
  })
})
