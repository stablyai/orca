import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: string[]
  lifecycle: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  routes: [],
  refusals: [],
  lifecycle: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../worktree/workspace-server', () => ({
  useWorkspaceServer: () => ({ routeHost: undefined, server: null })
}))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: (props: { hostId: string }) => {
    dependencies.refusals.push(props.hostId)
    return null
  }
}))

vi.mock('./MobileWebShellScreen', async () => {
  const React = await import('react')
  return {
    MobileWebShellScreen: (props: {
      hostId: string
      route: { pathname: string; params?: Record<string, string> }
    }) => {
      dependencies.routes.push(props.route)
      // Keep deps empty: pathname-driven effects would also run on prop updates and falsely look like remounts.
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

import MobileAgentSessionHistoryScreen from '../../app/h/[hostId]/agent-history/[worktreeId]'

async function renderRoute(): Promise<void> {
  await act(async () => {
    create(createElement(MobileAgentSessionHistoryScreen))
  })
}

describe('the agent-history route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.routes.length = 0
    dependencies.refusals.length = 0
    dependencies.lifecycle.length = 0
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
  })

  // encodeURIComponent leaves dot segments intact; refuse them before constructing a route the bridge rejects.

  it('refuses a dot-segment worktree id too, which is the other segment', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: '..', name: 'n' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.refusals.at(-1)).toBe('host-1')
  })

  it('refuses when the route names no worktree, which the shell could not open', async () => {
    dependencies.params = { hostId: 'host-1' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.refusals.at(-1)).toBe('host-1')
  })

  // Remount on route change to dispose the bridge that captured the previous route’s grants.
})
