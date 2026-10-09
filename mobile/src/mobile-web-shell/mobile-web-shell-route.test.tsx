import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  mounted: string[]
  /** The pathname each mount was told to open, which is the only thing the page can route on. */
  pathnames: string[]
  hostId: string
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  mounted: [],
  pathnames: [],
  hostId: 'host-1'
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
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

describe('the hybrid shell route', () => {
  beforeEach(() => {
    dependencies.mounted.length = 0
    dependencies.pathnames.length = 0
    dependencies.hostId = 'host-1'
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', 'ota')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('redirects to the host screen in a native build, and mounts nothing', async () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', undefined)
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect').map((node) => node.props.href)).toEqual(['/h/host-1'])
    expect(dependencies.mounted).toEqual([])
  })

  it('mounts the shell screen for this host in an OTA build', async () => {
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toEqual([])
    expect(dependencies.mounted).toEqual(['host-1'])
  })

  it('encodes the host id into the pathname, so no host id can bend the route', async () => {
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
    dependencies.hostId = '..'
    await renderRoute()
    // `encodeURIComponent` leaves a dot alone, and percent-escaping one would not help either: the
    // URL parser treats `%2e%2e` as a dot segment too. So this one reaches the bridge as a route
    // the pattern refuses, and the host is what turns it into a failure screen rather than a blank
    // WebView. Deep links are the way in, which is why it is worth having a verdict for.
    expect(dependencies.pathnames).toEqual(['/h/..'])
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test('/h/..')).toBe(false)
  })
})
