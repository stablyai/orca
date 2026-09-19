import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  routes: { pathname: string; params?: Record<string, string> }[]
  panels: { hostId: string; worktreeId: string; name?: string }[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  routes: [],
  panels: [],
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

// `firstParam` lives in the source-control barrel, which imports two dozen icons from a 1.14.0
// lucide barrel that re-exports a `LucideProvider` its own context.mjs does not have. Metro and the
// web builder each paper over it; nothing under test here renders an icon, so any name will do.
vi.mock('lucide-react-native', () => ({
  ArrowDown: vi.fn(),
  ArrowDownUp: vi.fn(),
  ArrowUp: vi.fn(),
  Check: vi.fn(),
  CloudUpload: vi.fn(),
  GitBranch: vi.fn(),
  GitPullRequestArrow: vi.fn(),
  History: vi.fn(),
  RefreshCw: vi.fn()
}))

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

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: {
    hostId: string
    route: { pathname: string; params?: Record<string, string> }
  }) => {
    dependencies.routes.push(props.route)
    return null
  }
}))

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

  it('renders the native panel while the flag read is still settling', async () => {
    // `index.tsx`'s frame, for its reason: the read is async and a store build never reaches
    // storage at all, so the native screen is the only thing this route may paint first.
    await renderRoute()
    expect(dependencies.panels[0]).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      name: 'my worktree'
    })
    expect(dependencies.panels).toHaveLength(1)
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
})
