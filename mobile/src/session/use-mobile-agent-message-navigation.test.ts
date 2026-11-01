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
import { parseOrcaSessionAddress } from '../../../src/shared/orca-session-address'
import { activateMobileUiLocale, mobileI18n } from '../i18n/mobile-i18n'

const focus = vi.hoisted(() => ({ active: true }))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) =>
      React.useEffect(() => (focus.active ? effect() : undefined), [effect, focus.active])
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
const leaf = '11111111-1111-4111-8111-111111111111'
const terminal: MobileSessionTab = {
  type: 'terminal',
  id: 'flattened',
  terminal: 'term_worker',
  parentTabId: 'parent',
  leafId: leaf,
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
        defaultTerminalHandlesToLiveInput: vi.fn(),
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

it.each(['claude', 'codex'] as const)(
  'opens a closed %s sender through the shared opener and real phone receiver',
  async (agent) => {
    let rows: MobileSessionTab[] = []
    const row = { ...chat, agent, id: 'agent-chat-tab-v1-actual' }
    const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) =>
      reply(
        method === 'orchestration.partyLocation'
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
      'orchestration.partyLocation',
      { address: 'term_worker', messageIds: ['mine'] },
      expect.any(Object)
    ])
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'orchestration.partyLocation',
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

it('routes a resolved terminal through caller focus and its actual grouped leaf', async () => {
  const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) =>
    reply(
      method === 'orchestration.partyLocation'
        ? { location: { kind: 'terminal', handle: 'term_worker' } }
        : method === 'terminal.focus'
          ? { focus: { worktreeId: 'destination' } }
          : { tabs: [terminal] }
    )
  )
  const h = mount(send)
  await act(async () => h.open())
  expect(send.mock.calls[1]).toEqual([
    'terminal.focus',
    { terminal: 'term_worker', navigation: 'caller' },
    expect.objectContaining({ budgetSpansConnect: true })
  ])
  expect(h.navigate).toHaveBeenCalledWith('destination', `parent:${leaf}`)
  expect(h.toast).not.toHaveBeenCalled()
})

it.each(['method_not_found', 'forbidden'])(
  'uses shared old-host %s policy for direct terminals and exact native roots',
  async (code) => {
    const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) =>
      method === 'orchestration.partyLocation'
        ? refused(code)
        : reply(
            method === 'terminal.focus'
              ? { focus: { worktreeId: 'destination' } }
              : method === 'session.tabs.list'
                ? { tabs: [terminal, chat] }
                : {}
          )
    )
    const h = mount(send)
    await act(async () => h.open())
    expect(h.navigate).toHaveBeenLastCalledWith('destination', `parent:${leaf}`)
    send.mockClear()
    h.sourceSelection.sessionTabsRef.current = [chat]
    const root: AgentMessageSource = {
      ...from,
      senders: [
        {
          ...from.senders[0],
          party: {
            ...from.senders[0].party,
            orcaSessionId: parseOrcaSessionAddress(`orca_session_id:${chat.sessionId}`)
          }
        }
      ]
    }
    await act(async () => h.open(root))
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'orchestration.partyLocation',
      'session.tabs.list',
      'session.tabs.activate'
    ])
    expect(h.navigate).toHaveBeenLastCalledWith(
      'source-workspace',
      structuredAgentSessionPaneKey(chat.id, chat.sessionId)
    )
    expect(h.toast).not.toHaveBeenCalled()
  }
)

it('never falls back after ambiguous lookup and carries its remaining budget into terminal output', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const send = vi.fn<Parameters<typeof mount>[0]>(async (method: string) => {
    if (method === 'orchestration.partyLocation') {
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
    'orchestration.partyLocation',
    'terminal.focus'
  ])
  expect(h.navigate).not.toHaveBeenCalled()
  expect(h.toast).toHaveBeenCalledTimes(1)
  send.mockClear()
  send.mockImplementation(async () => refused('timeout'))
  await act(async () => h.open())
  expect(send.mock.calls.map(([method]) => method)).toEqual(['orchestration.partyLocation'])
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

it('uses the shared named failure table and permits a fresh retry', async () => {
  const send = vi.fn<Parameters<typeof mount>[0]>(async () =>
    reply({ location: null, lost: 'chat' })
  )
  const h = mount(send)
  await act(async () => h.open())
  expect(h.toast).toHaveBeenCalledWith(
    "Worker's chat is no longer on this host, so it cannot be reopened here.",
    3000
  )
  await act(async () => h.open())
  expect(send).toHaveBeenCalledTimes(2)
})

it.each([
  'locate',
  'terminal_exited',
  'terminal_gone',
  'terminal_handle_stale',
  'terminal_not_found',
  'timeout'
])('translates one honest terminal outcome for %s at the actual arrow sink', async (code) => {
  mobileI18n.addResourceBundle('fr', 'translation', {
    'session.structuredOpen.paneUnavailable': 'Le panneau de l’agent n’est plus disponible.',
    'session.structuredOpen.unreachable': 'Conversation de {{agent}} indisponible : réessayez.'
  })
  await activateMobileUiLocale('fr')
  const send = vi.fn<Parameters<typeof mount>[0]>(async (method) =>
    method === 'orchestration.partyLocation'
      ? reply(
          code === 'locate'
            ? { location: null, lost: 'terminal' }
            : { location: { kind: 'terminal', handle: 'term_worker' } }
        )
      : refused(code)
  )
  const h = mount(send)
  await act(async () => h.open())
  expect(h.navigate).not.toHaveBeenCalled()
  expect(h.toast).toHaveBeenCalledExactlyOnceWith(
    code === 'timeout'
      ? 'Conversation de Worker indisponible : réessayez.'
      : 'Le panneau de l’agent n’est plus disponible.',
    3000
  )
  expect(send.mock.calls.map(([method]) => method)).toEqual(
    code === 'locate'
      ? ['orchestration.partyLocation']
      : ['orchestration.partyLocation', 'terminal.focus']
  )
})
