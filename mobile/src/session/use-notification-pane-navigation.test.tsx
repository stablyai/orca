import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from './mobile-session-route-types'

type RouteUpdateListener = (route: BridgeInitRoute | null) => void

const bridge = vi.hoisted(() => {
  const held: {
    route: BridgeInitRoute | null
    listeners: RouteUpdateListener[]
    cleared: { param: string; value: string }[]
  } = { route: null, listeners: [], cleared: [] }
  return held
})

vi.mock('../transport/client-context.web', () => ({
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

import { encodeInPageNotificationTarget } from '../notifications/in-page-notification-navigation'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
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
  },
  {
    type: 'agent-session',
    id: 'structured-agent-session-sess-99',
    sessionId: 'sess-99',
    title: 'Native Chat',
    agent: 'claude',
    status: 'waiting-approval',
    isActive: false
  }
]

const switched: MobileSessionTab[] = []

function Probe({
  terminalsLoaded,
  sessionTabs = TABS
}: {
  terminalsLoaded: boolean
  sessionTabs?: MobileSessionTab[]
}): null {
  useNotificationPaneNavigation({
    sessionTabs,
    terminalsLoaded,
    switchSessionTab: (tab) => switched.push(tab)
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
})

// Exercise the page hook: shell init carries pane requests because this document at / cannot edit the native route.
describe('the page pane hook', () => {
  it('switches to the pane the page was opened on, which arrives in the first init', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('holds that request until the terminals have loaded, rather than dropping it', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    const tree = render(false)
    expect(switched).toEqual([])
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('erases the param that carried the pane it applied', () => {
    // Erase by value so an older acknowledgement cannot spend a newer notification tap.
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(bridge.cleared).toEqual([{ param: 'paneKey', value: `tab-b:${LEAF}` }])
  })

  it('switches again for a repeat tap on the pane already showing', () => {
    // A clear between identical values makes the later value a new request.
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver('')
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'first'])
    expect(bridge.cleared).toEqual([
      { param: 'paneKey', value: `tab-a:${LEAF}` },
      { param: 'paneKey', value: `tab-a:${LEAF}` }
    ])
  })

  it('applies one pane once however many inits carry it', () => {
    // Replay must retry a lost clear without switching away from the user’s newer tab.
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toHaveLength(2)
  })

  it('applies successive pane requests and names each value when clearing', () => {
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-b:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'second'])
    expect(bridge.cleared.map((entry) => entry.value)).toEqual([`tab-a:${LEAF}`, `tab-b:${LEAF}`])
  })

  it('asks for nothing and applies nothing when the route carries no pane', () => {
    // The shell’s erase returns as a route update, including on later ready replies.
    render(true)
    deliver(`tab-a:${LEAF}`)
    bridge.cleared.length = 0
    deliver('')
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toEqual([])
  })

  it('stays on the open tab for a pane that has since closed', () => {
    render(true)
    deliver(`gone:${LEAF}`)
    expect(switched).toEqual([])
    deliver('')
    expect(switched).toEqual([])
  })

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

  it('does nothing at all when the page was opened on no pane', () => {
    render(true)
    expect(switched).toEqual([])
  })

  it('replaces the route in-page and switches tabs after cross-workspace tabs load', () => {
    const replaced: string[] = []
    function CrossProbe({
      worktreeId,
      tabs,
      terminalsLoaded
    }: {
      worktreeId: string
      tabs: MobileSessionTab[]
      terminalsLoaded: boolean
    }): null {
      useNotificationPaneNavigation({
        hostId: 'host-1',
        worktreeId,
        router: {
          replace: (href) => {
            replaced.push(typeof href === 'string' ? href : String(href))
          }
        },
        sessionTabs: tabs,
        terminalsLoaded,
        switchSessionTab: (tab) => switched.push(tab)
      })
      return null
    }

    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        createElement(CrossProbe, { worktreeId: 'wt-1', tabs: TABS, terminalsLoaded: true })
      )
    })
    deliver(
      encodeInPageNotificationTarget({
        worktreeId: 'wt-2',
        paneKey: `tab-b:${LEAF}`
      })
    )
    expect(replaced).toEqual([
      `/h/host-1/session/wt-2?paneKey=${encodeURIComponent(`tab-b:${LEAF}`)}`
    ])
    expect(switched).toEqual([])

    // Route switches to wt-2; startup clears sessionTabs before hydrating wt-2's tabs.
    act(() => {
      tree.update(
        createElement(CrossProbe, { worktreeId: 'wt-2', tabs: [], terminalsLoaded: false })
      )
    })
    expect(switched).toEqual([])

    act(() => {
      tree.update(
        createElement(CrossProbe, { worktreeId: 'wt-2', tabs: TABS, terminalsLoaded: true })
      )
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('switches to an agent-session tab even when paneKey carries the desktop structured tab id prefix', () => {
    render(true)
    const desktopPaneKey = structuredAgentSessionPaneKey('desktop-structured-tab-1', 'sess-99')
    deliver(desktopPaneKey)
    expect(switched.map((tab) => tab.id)).toEqual(['structured-agent-session-sess-99'])
  })
})
