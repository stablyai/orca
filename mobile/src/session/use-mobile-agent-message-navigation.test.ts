import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import type { RpcResponse } from '../transport/types'
import type { SendRequestOptions } from '../transport/rpc-client'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useNotificationPaneNavigation } from './use-notification-pane-navigation'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'

import { activateMobileUiLocale, mobileI18n } from '../i18n/mobile-i18n'

const focus = vi.hoisted(() => ({ active: true }))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) =>
      React.useEffect(() => (focus.active ? effect() : undefined), [effect, focus.active]),
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ setParams: () => {} })
  }
})
vi.mock('../platform/haptics', () => ({ triggerSelection: () => {} }))
const bridge: {
  route: BridgeInitRoute | null
  listener: (route: BridgeInitRoute | null) => void
  getShellSession: () => { route: BridgeInitRoute | null }
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  clearRouteParam: ReturnType<typeof vi.fn>
} = {
  route: null,
  listener: (_route: BridgeInitRoute | null) => {},
  getShellSession: () => ({ route: bridge.route }),
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => {
    bridge.listener = listener
    return () => {
      bridge.listener = () => {}
    }
  },
  clearRouteParam: vi.fn()
}
vi.mock('../transport/client-context.web', () => ({ usePageBridgeClient: () => bridge }))
const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: [
    {
      name: 'Worker',
      agent: 'codex',
      party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
    }
  ]
}
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
const refused = (code: string): RpcResponse => ({
  id: 'reply',
  ok: false,
  error: { code, message: 'private host diagnostic' }
})
const chat: MobileSessionTab = {
  type: 'agent-session',
  id: 'agent-session:live',
  sessionId: 'live-session',
  agent: 'codex',
  title: 'Worker',
  isActive: false
}

const trees: ReactTestRenderer[] = []
afterEach(async () => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()))
  vi.useRealTimers()
  focus.active = true
  bridge.route = null
  mobileI18n.removeResourceBundle('fr', 'translation')
  await activateMobileUiLocale('en')
})

function mount(
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
) {
  let generation = 1,
    sourceKey = 'source',
    destination: MobileSessionTab[] = []
  const client = stubRpcClient({ sendRequest, getGeneration: () => generation })
  const sourceSelection: Parameters<typeof useMobileAgentMessageNavigation>[4] = {
    worktreeId: 'source-workspace',
    activeSessionTabIdRef: { current: 'source' },
    selectedSessionTabIdRef: { current: null },
    sessionTabsRef: { current: [{ ...chat, id: 'source', isActive: true }] },
    pendingSelectionRef: { current: null }
  }
  const toast = vi.fn(),
    selected = vi.fn()
  const navigate = vi.fn((worktreeId: string, paneKey: string) => {
    bridge.route = { pathname: `/h/host/session/${worktreeId}`, params: { paneKey } }
    bridge.listener(bridge.route)
  })
  let open: ReturnType<typeof useMobileAgentMessageNavigation> = () => {}
  function Probe() {
    open = useMobileAgentMessageNavigation(client, navigate, sourceKey, toast, sourceSelection)
    const switching = useMobileSessionTabSwitching(
      mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
        client,
        worktreeId: 'destination',
        sessionTabs: destination,
        activeSessionTabId: null,
        markdownDocs: new Map(),
        fileDocs: new Map(),
        readMarkdownTab: vi.fn(),
        readFileTab: vi.fn(),
        setActiveSessionTabId: selected,
        setActiveHandle: vi.fn(),
        switchSessionTabRef: { current: null },
        terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
        pendingSelectionRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        activeHandleRef: { current: null },
        terminalUnsubsRef: { current: new Map() },
        subscribeToTerminal: vi.fn(),
        unsubscribeTerminal: vi.fn(),
        showToast: toast
      })
    )
    useNotificationPaneNavigation({
      worktreeId: 'destination',
      sessionTabs: destination,
      terminalsLoaded: true,
      switchSessionTab: switching.switchSessionTab
    })
    return null
  }
  let tree: ReactTestRenderer
  act(() => {
    tree = create(createElement(Probe))
  })
  trees.push(tree!)
  return {
    client,
    toast,
    navigate,
    selected,
    sourceSelection,
    open: (source = from) => open(source, source.senders[0]),
    redraw: (tabs = destination) => {
      destination = tabs
      act(() => tree!.update(createElement(Probe)))
    },
    replaceSource: () => {
      sourceKey += 'next'
      act(() => tree!.update(createElement(Probe)))
    },
    migrate: () => {
      generation++
    },
    unmount: () => act(() => tree!.unmount())
  }
}

it('does not change selection or contact the host for a named command source', () => {
  const send = vi.fn<Parameters<typeof mount>[0]>(async () => reply({}))
  const run = mount(send)
  run.open({
    ...from,
    senders: [
      {
        name: null,
        party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
      }
    ]
  })
  expect(send).not.toHaveBeenCalled()
  expect(run.sourceSelection.selectedSessionTabIdRef.current).toBeNull()
  expect(run.navigate).not.toHaveBeenCalled()
  expect(run.toast).not.toHaveBeenCalled()
})

it.each(['claude', 'codex'] as const)(
  'opens a closed %s sender through the shared opener and real phone receiver',
  async (agent) => {
    let rows: MobileSessionTab[] = []
    const row = { ...chat, agent, id: 'agent-chat-tab-v1-actual' }
    const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) =>
      reply(
        method === 'orchestration.partyOpen'
          ? { location: { kind: 'chat', sessionId: chat.sessionId, worktreeId: 'stale' } }
          : method === 'agentSession.reveal'
            ? ((rows = [row]),
              {
                ok: true,
                sessionId: chat.sessionId,
                workspaceId: 'destination',
                agent,
                readable: true
              })
            : method === 'session.tabs.list'
              ? { tabs: rows }
              : {}
      )
    )
    const h = mount(send)
    const source: AgentMessageSource = {
      ...from,
      orchestration: {
        message: 'mail-notice',
        mailbox: 'inbox',
        dispatchId: null,
        messages: [
          { from: 'term_worker', messageId: 'mine', runId: 'run' },
          { from: 'another', messageId: 'not-mine', runId: 'run' }
        ]
      }
    }
    await act(async () => {
      h.open(source)
      h.open(source)
    })
    expect(send.mock.calls[0]).toEqual([
      'orchestration.partyOpen',
      { address: 'term_worker', messageIds: ['mine'] },
      expect.any(Object)
    ])
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'orchestration.partyOpen',
      'session.tabs.list',
      'agentSession.reveal',
      'session.tabs.list',
      'session.tabs.activate'
    ])
    expect(send.mock.calls[2]).toEqual([
      'agentSession.reveal',
      { sessionId: chat.sessionId, navigation: 'caller' },
      expect.objectContaining({ budgetSpansConnect: true })
    ])
    expect(send.mock.calls[4]).toEqual([
      'session.tabs.activate',
      expect.objectContaining({ tabId: row.id, navigation: 'caller', notifyClients: false }),
      expect.any(Object)
    ])
    expect(h.navigate).toHaveBeenCalledWith(
      'destination',
      structuredAgentSessionPaneKey(row.id, chat.sessionId)
    )
    expect(h.selected).not.toHaveBeenCalled()
    await act(async () => h.redraw([row]))
    expect(h.selected).toHaveBeenCalledWith(row.id)
    expect(h.toast).not.toHaveBeenCalled()
  }
)

it('never falls back after ambiguous lookup and carries its remaining budget into terminal output', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) => {
    if (method === 'orchestration.partyOpen') {
      vi.setSystemTime(15000)
      return reply({ location: { kind: 'terminal', handle: 'term_worker' } })
    }
    vi.setSystemTime(16000)
    return reply({ focus: { worktreeId: 'destination' } })
  })
  const h = mount(send)
  await act(async () => h.open())
  expect(send.mock.calls[1]).toEqual([
    'terminal.focus',
    expect.any(Object),
    expect.objectContaining({ timeoutMs: 1000 })
  ])
  expect(send.mock.calls.map(([method]) => method)).toEqual([
    'orchestration.partyOpen',
    'terminal.focus'
  ])
  expect(h.navigate).not.toHaveBeenCalled()
  expect(h.toast).toHaveBeenCalledTimes(1)
  send.mockClear()
  send.mockImplementation(async () => refused('timeout'))
  await act(async () => h.open())
  expect(send.mock.calls.map(([method]) => method)).toEqual(['orchestration.partyOpen'])
})

it('retains the displayed source, respects pending selection, and fences stale source/visit/generation/newer intent', async () => {
  const pending: ((response: RpcResponse) => void)[] = []
  const h = mount(vi.fn(() => new Promise<RpcResponse>((resolve) => pending.push(resolve))))
  h.sourceSelection.selectedSessionTabIdRef.current = 'closed'
  h.open()
  h.open()
  expect(h.sourceSelection.selectedSessionTabIdRef.current).toBe('source')
  h.open({
    ...from,
    senders: [{ ...from.senders[0], party: { ...from.senders[0].party, address: 'term_b' } }]
  })
  h.open()
  expect(pending).toHaveLength(3)
  h.replaceSource()
  await act(async () =>
    pending.splice(0).forEach((resolve) => resolve(reply({ location: null, lost: 'chat' })))
  )
  for (const cancel of [
    () => h.migrate(),
    () => {
      focus.active = false
      h.redraw()
      focus.active = true
      h.redraw()
    },
    () => {
      h.sourceSelection.selectedSessionTabIdRef.current = 'newer'
      h.sourceSelection.pendingSelectionRef.current = { kind: 'tab', tabId: 'newer' }
    },
    () => h.unmount()
  ]) {
    h.open()
    cancel()
    await act(async () => pending.shift()!(reply({ location: null, lost: 'chat' })))
  }
  expect(h.navigate).not.toHaveBeenCalled()
  expect(h.toast).not.toHaveBeenCalled()
  expect(h.sourceSelection.selectedSessionTabIdRef.current).toBe('newer')
})

it('keeps Setup endpoint failure neutral without presenting it as an agent', async () => {
  const send = vi.fn<Parameters<typeof mount>[0]>(async (method) =>
    method === 'orchestration.partyOpen'
      ? reply({ location: { kind: 'terminal', handle: 'term_worker' } })
      : refused('terminal_gone')
  )
  const h = mount(send)
  await act(async () =>
    h.open({
      ...from,
      senders: [{ name: 'Setup', party: from.senders[0]!.party }]
    })
  )
  expect(send.mock.calls.map(([method]) => method)).toEqual([
    'orchestration.partyOpen',
    'terminal.focus'
  ])
  expect(h.toast).toHaveBeenCalledExactlyOnceWith(
    'Setup is no longer available. Open its terminal from the sidebar.',
    3000
  )
  expect(h.navigate).not.toHaveBeenCalled()
})
