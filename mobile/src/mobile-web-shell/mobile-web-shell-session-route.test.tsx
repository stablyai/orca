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
vi.mock('../worktree/workspace-server', () => ({
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

  // Remount on route change so the old bridge cannot retain the previous route’s grants.

  // Pane taps must update without remounting. Clear the native param after page consumption so a repeat tap becomes another change (rulings 33.1/34).
})
