import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: string[]
  /** `mount:<pathname>` / `unmount:<pathname>`, which is the only thing that tells a remount from
   *  a prop update — and a remount is what drops the old session's bridge and its grants. */
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

// The workspace route reads the desktop's connection to decide whether a server is reachable.
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../transport/workspace-server', () => ({
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

  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderRoute()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/agent-history/wt-1', params: { name: 'my worktree' } }
    ])
  })

  it('names no params when the caller named no worktree', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1' }
    await renderRoute()
    expect(dependencies.routes).toEqual([{ pathname: '/h/host-1/agent-history/wt-1' }])
  })

  /**
   * The ids encoding cannot save: `encodeURIComponent('..')` is `'..'`, which the bridge's segment
   * rule refuses, so the route refuses here rather than handing the page a route it would refuse.
   */
  it('refuses a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1', name: 'n' }
      dependencies.routes.length = 0
      dependencies.refusals.length = 0
      await renderRoute()
      expect(dependencies.routes, hostId).toEqual([])
      expect(dependencies.refusals.at(-1), hostId).toBe(hostId)
    }
  })

  it('refuses a dot-segment worktree id too, which is the other segment', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: '..', name: 'n' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.refusals.at(-1)).toBe('host-1')
  })

  it('encodes both dynamic segments, so a deep-linked id stays one segment each', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.params = { hostId, worktreeId: 'wt/1', name: 'n' }
      dependencies.routes.length = 0
      await renderRoute()
      const route = dependencies.routes[0]
      const pathname = route?.pathname ?? ''
      expect(pathname, hostId).toBe(
        `/h/${encodeURIComponent(hostId)}/agent-history/${encodeURIComponent('wt/1')}`
      )
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname), hostId).toBe(true)
      const [, , encodedHost, , encodedWorktree] = pathname.split('/')
      expect(decodeURIComponent(encodedHost ?? ''), hostId).toBe(hostId)
      expect(decodeURIComponent(encodedWorktree ?? ''), hostId).toBe('wt/1')
    }
  })

  it('refuses when the route names no worktree, which the shell could not open', async () => {
    dependencies.params = { hostId: 'host-1' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.refusals.at(-1)).toBe('host-1')
  })

  /**
   * A route change is a new session, and the old one's bridge must not outlive it.
   *
   * The host captures the grants its session was opened with, so a screen reused across a route
   * change keeps authorising frames under the grants of the route the page has left. Only a remount
   * drops it, and only a key guarantees one.
   */
  describe('changing the route this screen stands for', () => {
    it('remounts the shell, so the bridge opened for the old route is disposed', async () => {
      const rendered: { tree: ReturnType<typeof create> | null } = { tree: null }
      await act(async () => {
        rendered.tree = create(createElement(MobileAgentSessionHistoryScreen))
      })
      expect(dependencies.lifecycle).toEqual(['mount:/h/host-1/agent-history/wt-1'])
      dependencies.params = { hostId: 'host-1', worktreeId: 'wt-2', name: 'another worktree' }
      await act(async () => {
        rendered.tree?.update(createElement(MobileAgentSessionHistoryScreen))
      })
      // Unmount before mount: the old bridge is gone before the new session exists, rather than
      // being updated in place with the new route's props.
      expect(dependencies.lifecycle).toEqual([
        'mount:/h/host-1/agent-history/wt-1',
        'unmount:/h/host-1/agent-history/wt-1',
        'mount:/h/host-1/agent-history/wt-2'
      ])
    })
  })
})
