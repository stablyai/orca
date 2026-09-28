import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  routes: { pathname: string; params?: Record<string, string> }[]
  natives: number
  /** `mount:<pathname>` / `unmount:<pathname>`, which is the only thing that tells a remount from
   *  a prop update — and a remount is what drops the old session's bridge and its grants. */
  lifecycle: string[]
  /** Every `onRouteParamClear` the screen was handed, so a case can erase the way the page does. */
  clears: ((param: 'paneKey', value: string) => void)[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  routes: [],
  natives: 0,
  lifecycle: [],
  clears: [],
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

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({
    setParams: (next: Record<string, string>) => {
      dependencies.params = { ...dependencies.params, ...next }
    }
  })
}))

vi.mock('../session/MobileSessionRouteScreen', () => ({
  MobileSessionRouteScreen: () => {
    dependencies.natives += 1
    return null
  }
}))

vi.mock('./MobileWebShellScreen', async () => {
  const React = await import('react')
  return {
    MobileWebShellScreen: (props: {
      hostId: string
      route: { pathname: string; params?: Record<string, string> }
      onRouteParamClear?: (param: 'paneKey', value: string) => void
    }) => {
      dependencies.routes.push(props.route)
      if (props.onRouteParamClear) {
        dependencies.clears.push(props.onRouteParamClear)
      }
      // Empty deps on purpose: keyed on the pathname this would re-fire on a prop update and read
      // exactly like a remount, which is the one thing it exists to tell apart.
      const mountedAs = React.useRef(props.route.pathname)
      React.useEffect(() => {
        const pathname = mountedAs.current
        dependencies.lifecycle.push(`mount:${pathname}`)
        return () => {
          dependencies.lifecycle.push(`unmount:${pathname}`)
        }
      }, [])
      return null
    }
  }
})

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import MobileSessionScreen from '../../app/h/[hostId]/session/[worktreeId]'

async function renderSession(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(MobileSessionScreen))
  })
  if (renderer === null) {
    throw new Error('the session switch did not render')
  }
  return renderer
}

async function update(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(createElement(MobileSessionScreen))
  })
}

/** Every pane key the shell was handed, in the order it was handed them, clears included. */
function paneKeysSeen(): string[] {
  return dependencies.routes.map((route) => route.params?.paneKey ?? '')
}

beforeEach(() => {
  dependencies.storage.clear()
  dependencies.routes.length = 0
  dependencies.lifecycle.length = 0
  dependencies.clears.length = 0
  dependencies.natives = 0
  dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
  Object.assign(globalThis, { __DEV__: true })
  dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
})

describe('the native session route that hands off to the shell', () => {
  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderSession()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/session/wt-1', params: { name: 'my worktree' } }
    ])
  })

  it('renders the native screen while the flag read is still settling', async () => {
    // The element is built on every render and mounted only by `fallback`, so the count below is
    // what a settling read costs: one native screen, before the switch has an answer.
    dependencies.storage.delete('orca:mobileWebShellEnabled')
    await renderSession()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.natives).toBeGreaterThan(0)
  })

  /**
   * A repeated query key, which expo-router answers with an array.
   *
   * A bare read puts that array straight into a template, where `String(['a','b'])` is `a,b` and
   * `encodeURIComponent` makes it `a%2Cb` — one segment, so the bridge's segment rule accepts it
   * and the shell opens a page for a host that does not exist.
   */
  it('takes the first value of a repeated param, not the joined array', async () => {
    dependencies.params = {
      hostId: ['host-a', 'host-b'],
      worktreeId: ['wt-1', 'wt-2'],
      name: ['first', 'second'],
      paneKey: ['pane-1', 'pane-2']
    }
    await renderSession()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-a/session/wt-1', params: { name: 'first', paneKey: 'pane-1' } }
    ])
    const pathname = dependencies.routes[0]?.pathname ?? ''
    expect(pathname).not.toContain('%2C')
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname)).toBe(true)
  })

  it('stays native for a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1' }
      dependencies.routes.length = 0
      await renderSession()
      expect(dependencies.routes, hostId).toEqual([])
    }
  })

  it('encodes both dynamic segments, so a deep-linked id stays one segment each', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.params = { hostId, worktreeId: 'wt/1' }
      dependencies.routes.length = 0
      await renderSession()
      const pathname = dependencies.routes[0]?.pathname ?? ''
      expect(pathname, hostId).toBe(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent('wt/1')}`
      )
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname), hostId).toBe(true)
    }
  })

  it('renders the native screen with the flag off, which is every store build', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'false')
    await renderSession()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.natives).toBeGreaterThan(0)
  })

  /**
   * A route change is a new session, and the old one's bridge must not outlive it.
   *
   * The host captures the grants its session was opened with, so a screen reused across a route
   * change keeps authorising frames under the grants of the route the page has left.
   */
  it('remounts the shell when the route changes rather than updating it', async () => {
    const renderer = await renderSession()
    dependencies.params = { hostId: 'host-2', worktreeId: 'wt-9' }
    await update(renderer)
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/session/wt-1',
      'unmount:/h/host-1/session/wt-1',
      'mount:/h/host-2/session/wt-9'
    ])
  })

  it('remounts when a param other than the pane changes, which the page cannot learn otherwise', async () => {
    const renderer = await renderSession()
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'renamed' }
    await update(renderer)
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/session/wt-1',
      'unmount:/h/host-1/session/wt-1',
      'mount:/h/host-1/session/wt-1'
    ])
  })

  /**
   * The two pane cases (ruling 33.1). Both measure mounts, because a remount here is a bridge
   * teardown and a page reload for what is a tab switch.
   *
   * The spent tap is what made the repeat one unreachable: the page cleared the param on its own
   * router, the native route kept it, and `SET_PARAMS` writing the value already there moved no
   * key and remounted nothing. Here the page erases the native param (ruling 34), so the second
   * tap is a change again.
   */
  it('hands a repeat tap for the same pane to the mounted page, twice, with no remount', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', paneKey: 'pane-1' }
    const renderer = await renderSession()
    expect(paneKeysSeen()).toEqual(['pane-1'])
    // The page applied it and says so, naming what it applied.
    await act(async () => {
      dependencies.clears.at(-1)?.('paneKey', 'pane-1')
    })
    await update(renderer)
    expect(dependencies.params.paneKey).toBe('')
    // The same notification tapped again.
    dependencies.params = { ...dependencies.params, paneKey: 'pane-1' }
    await update(renderer)
    expect(paneKeysSeen().filter((key) => key === 'pane-1')).toHaveLength(2)
    expect(dependencies.lifecycle).toEqual(['mount:/h/host-1/session/wt-1'])
  })

  it('hands a different pane to the mounted page with no remount', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', paneKey: 'pane-1' }
    const renderer = await renderSession()
    dependencies.params = { ...dependencies.params, paneKey: 'pane-2' }
    await update(renderer)
    expect(paneKeysSeen().at(-1)).toBe('pane-2')
    expect(dependencies.lifecycle).toEqual(['mount:/h/host-1/session/wt-1'])
  })
})
