import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: number
  lifecycle: string[]
  clears: ((param: 'paneKey', value: string) => void)[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  routes: [],
  refusals: 0,
  lifecycle: [],
  clears: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../transport/workspace-server', () => ({
  useWorkspaceServer: () => ({ routeHost: undefined, server: null })
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({
    setParams: (next: Record<string, string>) => {
      dependencies.params = { ...dependencies.params, ...next }
    }
  })
}))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: () => {
    dependencies.refusals += 1
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
      // Keep deps empty so prop updates cannot impersonate remounts.
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

function paneKeysSeen(): string[] {
  return dependencies.routes.map((route) => route.params?.paneKey ?? '')
}

beforeEach(() => {
  dependencies.routes.length = 0
  dependencies.lifecycle.length = 0
  dependencies.clears.length = 0
  dependencies.refusals = 0
  dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
})

describe('the session route that hands off to the shell', () => {
  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderSession()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/session/wt-1', params: { name: 'my worktree' } }
    ])
  })

  // Read repeated Expo query keys through firstParam; encoding the array as a,b would invent one valid but nonexistent host segment.
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

  it('refuses a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1' }
      dependencies.routes.length = 0
      dependencies.refusals = 0
      await renderSession()
      expect(dependencies.routes, hostId).toEqual([])
      expect(dependencies.refusals, hostId).toBeGreaterThan(0)
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

  // Remount on route change so the old bridge cannot retain the previous route’s grants.
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

  // Pane taps must update without remounting. Clear the native param after page consumption so a repeat tap becomes another change (rulings 33.1/34).
  it('hands a repeat tap for the same pane to the mounted page, twice, with no remount', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', paneKey: 'pane-1' }
    const renderer = await renderSession()
    expect(paneKeysSeen()).toEqual(['pane-1'])
    await act(async () => {
      dependencies.clears.at(-1)?.('paneKey', 'pane-1')
    })
    await update(renderer)
    expect(dependencies.params.paneKey).toBe('')
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
