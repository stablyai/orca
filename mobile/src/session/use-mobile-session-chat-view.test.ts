import { createElement, useLayoutEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import { resetDefaultSessionViewStoreForTests } from '../storage/default-session-view-store'
import {
  readSessionViewOverridesPreference,
  updateSessionViewOverride
} from '../storage/session-view-preferences'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { getMobileChatPairWrites } from './mobile-session-chat-pair-writes'
import type { MobileSessionTab } from './mobile-session-route-types'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'
import { resolveMobileNativeChatGate } from './mobile-native-chat-render-data'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import {
  CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE,
  useMobileSessionChatView,
  type MobileSessionChatView
} from './use-mobile-session-chat-view'

const storage = vi.hoisted(() => {
  const state: { defaultView: 'terminal' | 'chat'; overrides: Map<string, 'terminal' | 'chat'> } = {
    defaultView: 'terminal',
    overrides: new Map()
  }
  return state
})

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('lucide-react-native', () => ({ MessageSquare: 'chat-icon', SquareTerminal: 'term-icon' }))
vi.mock('../storage/session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  readDefaultSessionViewPreference: vi.fn(async () => ({
    value: storage.defaultView,
    loaded: true,
    hasStoredValue: true
  })),
  saveDefaultSessionView: vi.fn(async () => {}),
  readSessionViewOverridesPreference: vi.fn(async () => ({
    overrides: new Map(storage.overrides),
    loaded: true
  })),
  updateSessionViewOverride: vi.fn(async () => {})
}))

type TerminalRow = Extract<MobileSessionTab, { type: 'terminal' }>
type Call = {
  method: string
  params: { tabId: string; viewMode: string; chatViewWrite: { writerId: string; seq: number } }
  options: unknown
  settle: (response: RpcResponse) => void
  fail: (error: unknown) => void
}

const sole: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'A' }

function terminalRow(overrides: Partial<TerminalRow> = {}): TerminalRow {
  return {
    type: 'terminal',
    id: 'P::A',
    title: 'claude',
    parentTabId: 'P',
    leafId: 'A',
    status: 'ready',
    terminal: 'term-A',
    ptyId: 'pty-A',
    parentLayout: { root: sole },
    isActive: true,
    ...overrides
  }
}

function claudeStatus(sessionId: string | null = 'session-1'): AgentStatusEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the phone reads only agentType, state and providerSession from a status.
  return {
    agentType: 'claude',
    state: 'idle',
    ...(sessionId ? { providerSession: { id: sessionId, transcriptPath: '/t.jsonl' } } : {})
  } as unknown as AgentStatusEntry
}

function fakeClient(): {
  client: RpcClient
  calls: Call[]
  setState: (next: ConnectionState) => void
} {
  const calls: Call[] = []
  let state: ConnectionState = 'connected'
  const listeners = new Set<(next: ConnectionState) => void>()
  const sendRequest = vi.fn(
    (method: string, params: unknown, options: unknown) =>
      new Promise<RpcResponse>((settle, fail) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only setTabProps reaches this fake; its params carry these members.
        calls.push({ method, params: params as Call['params'], options, settle, fail })
      })
  )
  const client = {
    sendRequest,
    getState: () => state,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const setState = (next: ConnectionState): void => {
    state = next
    for (const listener of listeners) {
      listener(next)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat view reaches the client only through sendRequest and its connection state.
  return { client: client as unknown as RpcClient, calls, setState }
}

function applied(
  chatView: { viewMode: 'terminal' | 'chat' | null; chatLeafId: string | null },
  superseded = false
): RpcResponse {
  return {
    id: 'reply',
    ok: true,
    result: { updated: true, chatView, ...(superseded ? { superseded: true } : {}) },
    _meta: { runtimeId: 'r' }
  }
}

function refused(code: string): RpcResponse {
  return { id: 'reply', ok: false, error: { code, message: code }, _meta: { runtimeId: 'r' } }
}

/** How a host that has no passthrough for `token` replies: the generic code, the token as the message. */
function refusedAsRuntimeError(token: string): RpcResponse {
  return {
    id: 'reply',
    ok: false,
    error: { code: 'runtime_error', message: token },
    _meta: { runtimeId: 'r' }
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve()
    }
  })
}

type Probe = {
  chatView: MobileSessionChatView
  showNativeChat: boolean
  agent: string | null
  gate: string | null
  toggleLabels: string[]
}

describe('useMobileSessionChatView', () => {
  let renderer: ReactTestRenderer | null = null
  let probe: Probe | null = null
  const toasts: string[] = []

  beforeEach(() => {
    resetDefaultSessionViewStoreForTests()
    storage.defaultView = 'terminal'
    storage.overrides = new Map()
    toasts.length = 0
    vi.mocked(updateSessionViewOverride).mockClear()
    vi.mocked(readSessionViewOverridesPreference).mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    probe = null
    vi.useRealTimers()
  })

  function Harness(props: { tabs: MobileSessionTab[]; marker: boolean; client: RpcClient }): null {
    const tabsRef = useRef(props.tabs)
    // Why layout: the hook reads this ref only after commit, from effects and taps.
    useLayoutEffect(() => {
      tabsRef.current = props.tabs
    })
    const chatView = useMobileSessionChatView({
      hostId: 'h',
      worktreeId: 'w',
      client: props.client,
      sessionTabs: props.tabs,
      sessionTabsRef: tabsRef,
      markerSession: props.marker,
      snapshotAccepted: true,
      readability: 'readable',
      onSwitchUnconfirmed: (message) => toasts.push(message)
    })
    const active = props.tabs.find((tab) => tab.isActive) ?? null
    const resolution = useMobileNativeChatActiveResolution({
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: active,
      activeSessionTabId: active?.id ?? null,
      activeHandleRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      view: {
        markerSession: chatView.markerSession,
        activeLeafView: chatView.tabLeafView(active),
        retainedIdentity: chatView.retainedIdentity(active?.id ?? null),
        isTabChatView: chatView.isTabChatView,
        setTabChatView: chatView.setTabChatView
      }
    })
    probe = {
      chatView,
      showNativeChat: resolution.showNativeChat,
      agent: resolution.activeChatResolution?.agent ?? null,
      gate:
        resolveMobileNativeChatGate({
          showNativeChat: resolution.showNativeChat,
          agent: resolution.activeChatResolution?.agent ?? null,
          tab: active,
          readability: 'readable'
        })?.title ?? null,
      toggleLabels: getMobileNativeChatToggleActions({
        tab: active?.type === 'terminal' ? active : null,
        leafView: chatView.tabLeafView(active),
        nativeChatTranscriptIsLocalReadable: true,
        onClose: () => {},
        onSetView: () => {}
      }).map((action) => action.label)
    }
    return null
  }

  async function render(tabs: MobileSessionTab[], marker: boolean, client: RpcClient) {
    await act(async () => {
      const element = createElement(Harness, { tabs, marker, client })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
      await Promise.resolve()
    })
  }

  function current(): Probe {
    if (!probe) {
      throw new Error('not mounted')
    }
    return probe
  }

  /** A press of the sheet item the leaf offers: it names the opposite of the view it shows. */
  async function toggle(tabId = 'P::A'): Promise<void> {
    const chat = current().chatView.isTabChatView(tabId)
    act(() => current().chatView.setTabChatView(tabId, chat ? 'terminal' : 'chat'))
    await flush()
  }

  it('never lets agent status change a Terminal-started agent tab, and a switch to chat sticks (#25166)', async () => {
    const { client, calls } = fakeClient()
    const statuses = [null, claudeStatus(), null, claudeStatus()]
    for (const agentStatus of statuses) {
      await render([terminalRow({ agentStatus })], true, client)
      expect(current().showNativeChat).toBe(false)
      expect(current().toggleLabels).toEqual(agentStatus ? ['Switch to chat view'] : [])
    }

    await toggle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({ tabId: 'P::A', viewMode: 'chat' })
    calls[0]!.settle(applied({ viewMode: 'chat', chatLeafId: 'A' }))
    await flush()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    for (const agentStatus of [claudeStatus(), null, claudeStatus(null), null]) {
      await render([terminalRow({ ...chosen, agentStatus })], true, client)
      expect(current().showNativeChat).toBe(true)
      // The transcript identity seen while status was present is kept through the lapse.
      expect(current().agent).toBe('claude')
      expect(current().gate).toBeNull()
      expect(current().toggleLabels).toEqual(['Switch to terminal view'])
    }
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
  })

  it('sends every click at once with rising sequence numbers, and only the latest reply counts (A1c-4a)', async () => {
    const { client, calls } = fakeClient()
    await render([terminalRow()], true, client)
    await toggle()
    await toggle()
    await toggle()
    expect(calls.map((call) => call.params.viewMode)).toEqual(['chat', 'terminal', 'chat'])
    const writes = calls.map((call) => call.params.chatViewWrite)
    expect(new Set(writes.map((write) => write.writerId)).size).toBe(1)
    expect(writes[1]!.seq).toBe(writes[0]!.seq + 1)
    expect(writes[2]!.seq).toBe(writes[1]!.seq + 1)

    calls[0]!.settle(refused('boom'))
    calls[1]!.settle(applied({ viewMode: 'terminal', chatLeafId: null }, true))
    await flush()
    expect(toasts).toEqual([])
    expect(current().chatView.tabLeafView(terminalRow())).toBe('chat')

    calls[2]!.settle(applied({ viewMode: 'chat', chatLeafId: 'A' }))
    await flush()
    expect(toasts).toEqual([])
    expect(current().chatView.tabLeafView(terminalRow())).toBe('chat')
  })

  it('reports a failed latest click once and returns to the host pair with no new snapshot (A1c-4b)', async () => {
    const { client, calls } = fakeClient()
    await render([terminalRow()], true, client)
    await toggle()
    expect(current().showNativeChat).toBe(true)
    calls[0]!.settle(refused('tab_not_found'))
    await flush()
    expect(toasts).toEqual([CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE])
    expect(current().showNativeChat).toBe(false)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
  })

  it('resends a delivery-unknown click once with the same writer and sequence on the replacement transport (A1c-4c)', async () => {
    const first = fakeClient()
    const second = fakeClient()
    await render([terminalRow()], true, first.client)
    await toggle()
    // The transport is replaced while the click is in flight; the entry survives it.
    await render([terminalRow()], true, second.client)
    expect(current().showNativeChat).toBe(true)
    first.calls[0]!.fail(markRpcDeliveryUnknown(new Error('relay RPC timed out')))
    await flush()
    expect(second.calls).toHaveLength(1)
    expect(second.calls[0]!.params.chatViewWrite).toEqual(first.calls[0]!.params.chatViewWrite)
    second.calls[0]!.settle(applied({ viewMode: 'chat', chatLeafId: 'A' }))
    await flush()
    expect(toasts).toEqual([])
    expect(current().showNativeChat).toBe(true)
  })

  it('treats the host relay timeout as delivery-unknown and gives up after one resend (RB-F1)', async () => {
    const { client, calls } = fakeClient()
    await render([terminalRow()], true, client)
    await toggle()
    // The reply a real host sends: the relay token is not a passthrough code.
    calls[0]!.settle(refusedAsRuntimeError('chat_view_relay_timeout'))
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.chatViewWrite).toEqual(calls[0]!.params.chatViewWrite)
    calls[1]!.settle(refused('chat_view_relay_timeout'))
    await flush()
    expect(calls).toHaveLength(2)
    expect(toasts).toEqual([CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE])
    expect(current().showNativeChat).toBe(false)
  })

  it('waits for the replacement transport before the resend after a drop, within the budget (RC-F1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { client, calls, setState } = fakeClient()
    await render([terminalRow()], true, client)
    await toggle()
    setState('disconnected')
    calls[0]!.fail(markRpcDeliveryUnknown(new Error('relay socket closed')))
    await flush()
    expect(calls).toHaveLength(1)
    setState('connected')
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.chatViewWrite).toEqual(calls[0]!.params.chatViewWrite)
    calls[1]!.settle(applied({ viewMode: 'chat', chatLeafId: 'A' }))
    await flush()
    expect(toasts).toEqual([])

    // With no replacement inside the budget the switch ends once, with one toast.
    await toggle()
    setState('reconnecting')
    calls[2]!.fail(markRpcDeliveryUnknown(new Error('relay socket closed')))
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(calls).toHaveLength(3)
    expect(toasts).toEqual([CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE])
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
  })

  it('defers a reply naming a view mode this build does not know to the snapshot, with no toast (RC-F3)', async () => {
    const { client, calls } = fakeClient()
    await render([terminalRow({ agentStatus: claudeStatus() })], true, client)
    await toggle()
    calls[0]!.settle({
      id: 'reply',
      ok: true,
      result: { updated: true, chatView: { viewMode: 'split-view', chatLeafId: 'A' } },
      _meta: { runtimeId: 'r' }
    })
    await flush()
    expect(toasts).toEqual([])
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(false)
  })

  it('adopts the host-normalized reply and retires it on the matching snapshot or after 5 s (A1c-4d)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { client, calls } = fakeClient()
    await render([terminalRow()], true, client)

    // A refused stale write names the pair the host holds; it matches the snapshot, so it retires at once.
    await toggle()
    calls[0]!.settle(applied({ viewMode: null, chatLeafId: null }, true))
    await flush()
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(false)

    await toggle()
    calls[1]!.settle(applied({ viewMode: 'chat', chatLeafId: 'A' }))
    await flush()
    expect(current().showNativeChat).toBe(true)
    await render(
      [terminalRow({ viewMode: 'chat', parentLayout: { root: sole, chatLeafId: 'A' } })],
      true,
      client
    )
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(true)

    // A reply the snapshot never shows expires and the host pair renders again.
    await toggle()
    calls[2]!.settle(applied({ viewMode: 'terminal', chatLeafId: null }))
    await flush()
    expect(current().showNativeChat).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(true)
  })

  it('drops a pending click when the marker flips, even with identical rows (A1c-4e, R4.1-4)', async () => {
    const { client, calls } = fakeClient()
    const rows = [terminalRow({ agentStatus: claudeStatus() })]
    await render(rows, true, client)
    await toggle()
    expect(current().showNativeChat).toBe(true)
    await render(rows, false, client)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    calls[0]!.settle(refused('boom'))
    await flush()
    expect(toasts).toEqual([])
  })

  it('drops a pending click when only the PTY behind the leaf changes (R4.1-4)', async () => {
    const { client } = fakeClient()
    await render([terminalRow()], true, client)
    await toggle()
    expect(current().showNativeChat).toBe(true)
    await render([terminalRow({ ptyId: 'pty-A2' })], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(false)
  })

  it('keeps a pending click when a pending row gains its first PTY', async () => {
    const { client } = fakeClient()
    await render(
      [terminalRow({ ptyId: undefined, terminal: null, status: 'pending-handle' })],
      true,
      client
    )
    await toggle()
    await render([terminalRow()], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toHaveLength(1)
  })

  it('drops the identity it retained when the PTY changes (R4.1-4)', async () => {
    const { client } = fakeClient()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    await render([terminalRow({ ...chosen, agentStatus: claudeStatus() })], true, client)
    await render([terminalRow({ ...chosen })], true, client)
    expect(current().agent).toBe('claude')
    await render([terminalRow({ ...chosen, ptyId: 'pty-A2' })], true, client)
    expect(current().showNativeChat).toBe(true)
    expect(current().agent).toBeNull()
    // A1c-3: with no identity only the gate's copy renders, with no composer.
    expect(current().gate).toBe('No conversation here')
  })

  it('keeps each tab its own identity through a status lapse across a visit to another tab (R2-F1)', async () => {
    const { client } = fakeClient()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    const other = (isActive: boolean) =>
      terminalRow({
        id: 'Q::A',
        parentTabId: 'Q',
        terminal: 'term-Q',
        ptyId: 'pty-Q',
        isActive
      })
    await render(
      [terminalRow({ ...chosen, agentStatus: claudeStatus() }), other(false)],
      true,
      client
    )
    await render([terminalRow({ ...chosen, isActive: false }), other(true)], true, client)
    await render([terminalRow({ ...chosen }), other(false)], true, client)
    expect(current()).toMatchObject({ showNativeChat: true, agent: 'claude', gate: null })
    expect(current().chatView.retainedIdentity('P::A')?.sessionId).toBe('session-1')
  })

  it('keeps identity and a pending click across a snapshot that omits the PTY id (R2-F2)', async () => {
    const { client } = fakeClient()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    await render([terminalRow({ ...chosen, agentStatus: claudeStatus() })], true, client)
    await render([terminalRow({ ...chosen, ptyId: null })], true, client)
    await render([terminalRow({ ...chosen, ptyId: '' })], true, client)
    await render([terminalRow({ ...chosen })], true, client)
    expect(current()).toMatchObject({ agent: 'claude', gate: null })

    await toggle()
    await render([terminalRow({ ...chosen, ptyId: null })], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toHaveLength(1)
    // An unknown id carries the last known one forward, so a new PTY after it still counts.
    await render([terminalRow({ ...chosen, ptyId: 'pty-A2' })], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
  })

  it('treats an incarnation id appearing or vanishing for the same PTY as the same process (R4-n1)', async () => {
    const { client } = fakeClient()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    // Main publishes the incarnation; the desktop republishes the same leaf without it.
    await render(
      [terminalRow({ ...chosen, incarnationId: 'inc-1', agentStatus: claudeStatus() })],
      true,
      client
    )
    await toggle()
    await render([terminalRow({ ...chosen })], true, client)
    await render([terminalRow({ ...chosen, incarnationId: 'inc-1' })], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toHaveLength(1)
    expect(current().chatView.retainedIdentity('P::A')?.agent).toBe('claude')
    await render([terminalRow({ ...chosen, incarnationId: 'inc-2' })], true, client)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().chatView.retainedIdentity('P::A')).toBeNull()
  })

  it('keeps an ownerless chat on its agent leaf when the tab is split, as the desktop does (R1-F1)', async () => {
    const { client } = fakeClient()
    const agent = (overrides: Partial<TerminalRow> = {}) =>
      terminalRow({ viewMode: 'chat', launchAgent: 'claude', ...overrides })
    await render([agent({ parentLayout: { root: sole, activeLeafId: 'A' } })], true, client)
    expect(current().showNativeChat).toBe(true)
    // A headless split makes the new shell leaf active and names no owner.
    const split = {
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: sole,
        second: { type: 'leaf' as const, leafId: 'N' }
      },
      activeLeafId: 'N'
    }
    const shell = terminalRow({
      id: 'P::N',
      leafId: 'N',
      terminal: 'term-N',
      ptyId: 'pty-N',
      viewMode: 'chat',
      parentLayout: split,
      isActive: false
    })
    await render([agent({ parentLayout: split }), shell], true, client)
    expect(current().chatView.tabLeafView(agent({ parentLayout: split }))).toBe('chat')
    expect(current().chatView.tabLeafView(shell)).toBe('terminal')
  })

  it('shows terminal, not the empty chat, for an ownerless chat on a leaf that cannot show chat (R1-F1)', async () => {
    const { client } = fakeClient()
    await render([terminalRow({ viewMode: 'chat' })], true, client)
    expect(current()).toMatchObject({ showNativeChat: false, gate: null })
    // Once an agent shows up there, the chat claims that leaf and keeps it through a lapse.
    await render([terminalRow({ viewMode: 'chat', agentStatus: claudeStatus() })], true, client)
    await render([terminalRow({ viewMode: 'chat' })], true, client)
    expect(current()).toMatchObject({ showNativeChat: true, agent: 'claude', gate: null })
  })

  it('writes the view the user named even after another device switched meanwhile (R2-F3)', async () => {
    const { client, calls } = fakeClient()
    const chosen = { viewMode: 'chat' as const, parentLayout: { root: sole, chatLeafId: 'A' } }
    await render([terminalRow({ ...chosen, agentStatus: claudeStatus() })], true, client)
    // The desktop switched to terminal while the composer's agent-picker command was in flight.
    await render([terminalRow({ viewMode: 'terminal', agentStatus: claudeStatus() })], true, client)
    act(() => current().chatView.setTabChatView('P::A', 'terminal'))
    await flush()
    expect(calls.map((call) => call.params.viewMode)).toEqual(['terminal'])
  })

  it('switches a chat row with no terminal handle back by tab id, with no terminal call (A1c-6 iii)', async () => {
    const { client, calls } = fakeClient()
    const handleless = terminalRow({
      id: 'P::L',
      leafId: 'L',
      terminal: null,
      status: 'pending-handle',
      ptyId: undefined,
      viewMode: 'chat',
      parentLayout: { root: { type: 'leaf', leafId: 'L' }, chatLeafId: 'L' }
    })
    await render([handleless], true, client)
    expect(current().chatView.tabLeafView(handleless)).toBe('chat')
    expect(current().toggleLabels).toEqual(['Switch to terminal view'])
    await toggle('P::L')
    expect(calls.map((call) => call.method)).toEqual(['session.tabs.setTabProps'])
    expect(calls[0]!.params).toMatchObject({ tabId: 'P::L', viewMode: 'terminal' })
    expect(calls[0]!.params.chatViewWrite.seq).toBeGreaterThan(0)
  })

  it('ends the overlay with no further write when the host answers with an ownerless chat', async () => {
    const { client, calls } = fakeClient()
    // A headless tab with no stored layout cannot hold an owner.
    const unlaidOut = { parentLayout: undefined, agentStatus: claudeStatus() }
    await render([terminalRow(unlaidOut)], true, client)
    await toggle()
    calls[0]!.settle(applied({ viewMode: 'chat', chatLeafId: null }))
    await flush()
    await render([terminalRow({ ...unlaidOut, viewMode: 'chat' })], true, client)
    await render([terminalRow({ ...unlaidOut, viewMode: 'chat', title: 'retitled' })], true, client)
    await flush()
    expect(calls).toHaveLength(1)
    expect(getMobileChatPairWrites().pendingKeys()).toEqual([])
    expect(current().showNativeChat).toBe(true)
  })

  it('lets the accepted snapshot alone decide, with no capability probe (A1c-5)', async () => {
    const { client, calls } = fakeClient()
    await render([terminalRow({ launchAgent: 'claude' })], true, client)
    expect(current().chatView.markerSession).toBe(true)
    await toggle()
    expect(calls.map((call) => call.method)).toEqual(['session.tabs.setTabProps'])
  })

  it('keeps the legacy per-device override on a host without the marker (A1c-10 guard)', async () => {
    storage.overrides = new Map([['P::A', 'chat']])
    const { client, calls } = fakeClient()
    await render([terminalRow({ agentStatus: claudeStatus() })], false, client)
    await flush()
    expect(current().showNativeChat).toBe(true)
    await render([terminalRow()], false, client)
    expect(current().showNativeChat).toBe(false)
    act(() => current().chatView.setTabChatView('P::A', 'terminal'))
    await flush()
    expect(calls).toEqual([])
    expect(updateSessionViewOverride).toHaveBeenCalledWith('h', 'w', 'P::A', 'terminal')
  })

  it('neither consults nor writes a legacy override on a marker session (Q-A3)', async () => {
    storage.overrides = new Map([['P::A', 'chat']])
    const { client } = fakeClient()
    await render([terminalRow({ agentStatus: claudeStatus() })], true, client)
    await flush()
    expect(current().showNativeChat).toBe(false)
    await toggle()
    expect(updateSessionViewOverride).not.toHaveBeenCalled()
  })

  it('opens an unswitched agent-launched tab in this device default once it settles', async () => {
    storage.defaultView = 'chat'
    const { client } = fakeClient()
    await render([terminalRow({ launchAgent: 'claude' })], true, client)
    await flush()
    expect(current().chatView.tabLeafView(terminalRow({ launchAgent: 'claude' }))).toBe('chat')
  })
})
