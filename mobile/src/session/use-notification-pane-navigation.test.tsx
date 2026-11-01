import type { PendingSessionSelection } from './pending-session-selection'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { StructuredSessionOpenSource } from '../../../src/shared/open-structured-agent-session'
import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from './mobile-session-route-types'

vi.mock('../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => 'local'
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
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

import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { ConnectionState } from '../transport/types'
import { useMobileStructuredSessionOpening } from './use-mobile-structured-session-opening'
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
})

it('opens a missing canonical native notification once, only after inventory loads', () => {
  const openNativeSession = vi.fn(async () => {})
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId('historical'),
    'historical'
  )
  bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey } }
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(createElement(Probe, { terminalsLoaded: false, openNativeSession }))
  })
  expect(openNativeSession).not.toHaveBeenCalled()
  act(() => {
    tree?.update(createElement(Probe, { terminalsLoaded: true, openNativeSession }))
  })
  expect(openNativeSession).toHaveBeenCalledExactlyOnceWith({
    kind: 'notification',
    sessionId: 'historical',
    worktreeId: 'wt-1'
  })
  deliver(paneKey)
  expect(openNativeSession).toHaveBeenCalledOnce()
  act(() => tree?.unmount())
})
it('routes an existing native notification through lineage instead of selecting its historical tab directly', () => {
  const openNativeSession = vi.fn(async () => {})
  const tab: MobileSessionTab = {
    type: 'agent-session',
    id: 'issued',
    sessionId: 'historical',
    agent: 'codex',
    title: 'Chat',
    isActive: false
  }
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(
      createElement(Probe, { terminalsLoaded: true, sessionTabs: [tab], openNativeSession })
    )
  })
  deliver(structuredAgentSessionPaneKey('issued', 'historical'))
  expect(openNativeSession).toHaveBeenCalledExactlyOnceWith({
    kind: 'notification',
    sessionId: 'historical',
    worktreeId: 'wt-1',
    agent: 'codex'
  })
  expect(switched).toEqual([])
  act(() => tree?.unmount())
})

it.each([false, true])(
  'retains a disconnected unstarted native receipt until reconnect, listed=%s',
  async (listed) => {
    let connection: ConnectionState = 'disconnected'
    const client = createFakeRpcClient({ getState: () => connection })
    const current: MobileSessionTab = {
      type: 'agent-session',
      id: 'issued-S',
      sessionId: 'successor',
      agent: 'codex',
      title: 'Chat',
      isActive: false
    }
    const historical: MobileSessionTab = { ...current, id: 'issued-R', sessionId: 'historical' }
    const rows = listed ? [TABS[0]!, historical] : [TABS[0]!]
    const send = vi.spyOn(client, 'sendRequest').mockImplementation(async (method) => ({
      id: 'reply',
      ok: true,
      result:
        method === 'orchestration.partyLocation'
          ? { location: { kind: 'chat', sessionId: 'successor', worktreeId: 'wt-1' } }
          : method === 'session.tabs.list'
            ? { tabs: [current] }
            : {}
    }))
    const switchTab = vi.fn()
    function Joined() {
      const active = useRef('first'),
        selected = useRef<string | null>('first')
      const pending = useRef<PendingSessionSelection | null>(null)
      const tabs = useRef(rows)
      const open = useMobileStructuredSessionOpening({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        client,
        connState: connection,
        showToast: vi.fn(),
        switchSessionTab: switchTab,
        activeSessionTabIdRef: active,
        selectedSessionTabIdRef: selected,
        pendingSelectionRef: pending,
        sessionTabsRef: tabs
      })
      useNotificationPaneNavigation({
        sessionTabs: rows,
        terminalsLoaded: true,
        connState: connection,
        switchSessionTab: switchTab,
        worktreeId: 'wt-1',
        openNativeSession: open
      })
      return null
    }
    let tree: ReactTestRenderer | undefined
    await act(async () => {
      tree = create(createElement(Joined))
    })
    const pane = structuredAgentSessionPaneKey(
      listed ? 'issued-R' : structuredAgentSessionTabId('historical'),
      'historical'
    )
    deliver(pane)
    expect(send).not.toHaveBeenCalled()
    await act(async () => {
      connection = 'connected'
      tree?.update(createElement(Joined))
    })
    expect(switchTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'issued-S', sessionId: 'successor' }),
      { activate: false }
    )
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'orchestration.partyLocation',
      'session.tabs.list',
      'session.tabs.activate'
    ])
    deliver(pane)
    await act(async () => {
      connection = 'disconnected'
      tree?.update(createElement(Joined))
      connection = 'connected'
      tree?.update(createElement(Joined))
    })
    expect(switchTab).toHaveBeenCalledOnce()
    expect(send.mock.calls.filter(([method]) => method === 'agentSession.reveal')).toHaveLength(0)
    await act(async () => tree?.unmount())
  }
)
