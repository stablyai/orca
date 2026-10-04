import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  routes: { pathname: string; params?: Record<string, string> }[]
  panels: { hostId: string; worktreeId: string; name?: string }[]
  /** `mount:<pathname>` / `unmount:<pathname>`, which is the only thing that tells a remount from
   *  a prop update — and a remount is what drops the old session's bridge and its grants. */
  lifecycle: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  routes: [],
  panels: [],
  lifecycle: [],
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

vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('../agent-history/MobileAgentSessionHistoryPanel', () => ({
  MobileAgentSessionHistoryPanel: (props: {
    hostId: string
    worktreeId: string
    name?: string
  }) => {
    dependencies.panels.push(props)
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

describe('the native agent-history route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.routes.length = 0
    dependencies.panels.length = 0
    dependencies.lifecycle.length = 0
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
    Object.assign(globalThis, { __DEV__: true })
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
  })

  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderRoute()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/agent-history/wt-1', params: { name: 'my worktree' } }
    ])
  })

  it('renders neither panel nor shell while the flag read is still settling', async () => {
    // `index.tsx`'s frame, for its reason: the read is async, so the native panel used to mount
    // here and be replaced by the page the moment a flag-on read landed. No `await` inside `act`,
    // which leaves the read's promise pending and catches the route in that window.
    act(() => {
      create(createElement(MobileAgentSessionHistoryScreen))
    })
    expect(dependencies.panels).toEqual([])
    expect(dependencies.routes).toEqual([])
    await act(async () => {})
  })

  it('names no params when the caller named no worktree', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1' }
    await renderRoute()
    expect(dependencies.routes).toEqual([{ pathname: '/h/host-1/agent-history/wt-1' }])
  })

  it('renders the native panel with the flag off, which is every store build', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'false')
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.panels.at(-1)).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      name: 'my worktree'
    })
  })

  /**
   * The ids encoding cannot save, which now keep the route native instead of failing it.
   *
   * `encodeURIComponent('..')` is `'..'`, so a dot-segment id reaches the bridge's own segment rule
   * intact and `BridgeInitRouteSchema` refuses it. Before this the route handed it over anyway,
   * `bridge-host.ts` dropped the route to null, and the page answered with "Update Orca to open
   * this workspace" — a failure screen in place of the native panel sitting right behind the
   * switch. The route decides first now, the way C3.1's files routes do.
   */
  it('stays native for a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1', name: 'n' }
      dependencies.routes.length = 0
      dependencies.panels.length = 0
      await renderRoute()
      expect(dependencies.routes, hostId).toEqual([])
      expect(dependencies.panels.at(-1), hostId).toEqual({
        hostId,
        worktreeId: 'wt-1',
        name: 'n'
      })
    }
  })

  it('stays native for a dot-segment worktree id too, which is the other segment', async () => {
    dependencies.params = { hostId: 'host-1', worktreeId: '..', name: 'n' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.panels.at(-1)).toEqual({ hostId: 'host-1', worktreeId: '..', name: 'n' })
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

  it('stays native when the route names no worktree, which the shell could not open', async () => {
    dependencies.params = { hostId: 'host-1' }
    await renderRoute()
    expect(dependencies.routes).toEqual([])
    expect(dependencies.panels.at(-1)).toEqual({ hostId: 'host-1', worktreeId: '', name: '' })
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
      // The flag read is async, so the shell is not on screen until it settles; the other cases here
      // flush it the same way.
      await act(async () => {
        await Promise.resolve()
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
