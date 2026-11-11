import type { StructuredSessionOpenSource } from '../../../../src/shared/open-structured-agent-session'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInitRoute } from '../../mobile-web-shell/bridge/bridge-init-route'
import type { MobileSessionTab } from './mobile-session-tabs'

vi.mock('../../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => 'local'
}))
vi.mock('../../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: vi.fn() })
}))

type RouteUpdateListener = (route: BridgeInitRoute | null) => void

const bridge = vi.hoisted(() => {
  const held: {
    route: BridgeInitRoute | null
    listeners: RouteUpdateListener[]
    cleared: { param: string; value: string }[]
  } = { route: null, listeners: [], cleared: [] }
  return held
})

// The page's own router: an in-page hop puts the tapped pane in its URL, not in the shell route.
const pageUrl = vi.hoisted(() => {
  const url: {
    params: { paneKey?: string }
    setParams: (next: { paneKey?: string }) => void
  } = {
    params: {},
    setParams: (next) => {
      url.params = { ...url.params, ...next }
    }
  }
  return url
})
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => pageUrl.params,
  useNavigation: () => pageUrl
}))

vi.mock('../../transport/connection/client-context.web', () => ({
  usePageBridgeClient: () => ({
    getShellSession: () => ({ route: bridge.route }),
    onRouteUpdate: (listener: RouteUpdateListener) => {
      bridge.listeners.push(listener)
      return () => {
        bridge.listeners = bridge.listeners.filter((held) => held !== listener)
      }
    },
    clearRouteParam: (param: string, value: string) => {
      bridge.cleared.push({ param, value })
      return true
    }
  })
}))

import { useNotificationPaneNavigation } from './use-notification-pane-navigation'

// Use a real leaf id; invalid keys would test only the closed-pane path.
const LEAF = '11111111-1111-4111-8111-111111111111'

const TABS: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    parentTabId: 'tab-a',
    leafId: LEAF,
    title: 'first',
    terminal: 'pty-a',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'tab-b',
    leafId: LEAF,
    title: 'second',
    terminal: 'pty-b',
    isActive: false
  }
]

const switched: MobileSessionTab[] = []

function Probe({
  terminalsLoaded,
  sessionTabs = TABS,
  openNativeSession
}: {
  terminalsLoaded: boolean
  sessionTabs?: MobileSessionTab[]
  openNativeSession?: (source: StructuredSessionOpenSource) => Promise<void>
}): null {
  useNotificationPaneNavigation({
    sessionTabs,
    terminalsLoaded,
    switchSessionTab: (tab) => switched.push(tab),
    worktreeId: 'wt-1',
    openNativeSession
  })
  return null
}

function render(terminalsLoaded: boolean): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Probe, { terminalsLoaded }))
  })
  if (rendered.tree === null) {
    throw new Error('the probe did not render')
  }
  return rendered.tree
}

function deliver(paneKey: string): void {
  act(() => {
    for (const listener of bridge.listeners.slice()) {
      listener({ pathname: '/h/host-1/session/wt-1', params: { paneKey } })
    }
  })
}

beforeEach(() => {
  bridge.route = null
  bridge.listeners = []
  bridge.cleared.length = 0
  switched.length = 0
  pageUrl.params = {}
})

// Exercise the page hook: shell init carries pane requests because this document at / cannot edit the native route.
describe('the page pane hook', () => {
  it('opens a pane missing from a list loaded before the push once a fresh list names it', () => {
    const tree = render(true)
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true, sessionTabs: [TABS[0]!] }))
    })
    deliver(`tab-b:${LEAF}`)
    expect(switched).toEqual([])
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true, sessionTabs: TABS }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('switches to the agent row tapped in the host list when the page opened the session itself', () => {
    // #34235: the shell route stays the host list, so the tapped pane is only in the page URL.
    bridge.route = { pathname: '/h/host-1' }
    pageUrl.params = { paneKey: `tab-b:${LEAF}` }
    const tree = render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
    act(() => {
      tree.unmount()
    })
    render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('follows a newer notification the shell holds over the pane the URL copied at bootstrap', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    pageUrl.params = { paneKey: `tab-a:${LEAF}` }
    render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
    expect(pageUrl.params.paneKey).toBeUndefined()
  })
})
