import { createElement, useLayoutEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import { resetDefaultSessionViewStoreForTests } from '../storage/default-session-view-store'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatReadability } from './mobile-session-chat-view'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  useMobileSessionChatView,
  type MobileSessionChatView
} from './use-mobile-session-chat-view'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../storage/session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  readDefaultSessionViewPreference: vi.fn(async () => ({
    value: 'terminal',
    loaded: true,
    hasStoredValue: true
  })),
  saveDefaultSessionView: vi.fn(async () => {}),
  readSessionViewOverridesPreference: vi.fn(async () => ({ overrides: new Map(), loaded: true })),
  updateSessionViewOverride: vi.fn(async () => {})
}))

type TerminalRow = Extract<MobileSessionTab, { type: 'terminal' }>

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (first: string, second: string, activeLeafId: string) => ({
  root: {
    type: 'split' as const,
    direction: 'vertical' as const,
    first: leaf(first),
    second: leaf(second)
  },
  activeLeafId
})

function status(agentType: string): AgentStatusEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the phone reads only agentType, state and providerSession from a status.
  return {
    agentType,
    state: 'idle',
    providerSession: { id: `s-${agentType}`, transcriptPath: '/t.jsonl' }
  } as unknown as AgentStatusEntry
}

/** A pane of tab T under a host chat that names no pane. */
function pane(leafId: string, overrides: Partial<TerminalRow> = {}): TerminalRow {
  return {
    type: 'terminal',
    id: `T::${leafId}`,
    title: 'shell',
    parentTabId: 'T',
    leafId,
    status: 'ready',
    terminal: `term-${leafId}`,
    ptyId: `pty-${leafId}`,
    viewMode: 'chat',
    isActive: false,
    ...overrides
  }
}

describe('an ownerless host chat on the phone', () => {
  let renderer: ReactTestRenderer | null = null
  let chatView: MobileSessionChatView | null = null
  const toasts: string[] = []
  const fails: ((error: unknown) => void)[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat view reaches the client only through sendRequest and its connection state.
  const client = {
    sendRequest: vi.fn(() => new Promise((_settle, fail) => fails.push(fail))),
    getState: () => 'connected'
  } as unknown as RpcClient

  beforeEach(() => resetDefaultSessionViewStoreForTests())
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    toasts.length = 0
  })

  function Harness(props: {
    tabs: MobileSessionTab[]
    readability: MobileNativeChatReadability
  }): null {
    const tabsRef = useRef(props.tabs)
    // Why layout: the hook reads this ref only after commit, from effects and taps.
    useLayoutEffect(() => {
      tabsRef.current = props.tabs
    })
    chatView = useMobileSessionChatView({
      hostId: 'h-ownerless',
      worktreeId: 'w',
      client,
      sessionTabs: props.tabs,
      sessionTabsRef: tabsRef,
      markerSession: true,
      snapshotAccepted: true,
      readability: props.readability,
      onSwitchUnconfirmed: (message) => toasts.push(message)
    })
    return null
  }

  async function render(
    tabs: TerminalRow[],
    readability: MobileNativeChatReadability = 'readable'
  ): Promise<Record<string, string>> {
    await act(async () => {
      const element = createElement(Harness, { tabs, readability })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve()
      }
    })
    return Object.fromEntries(tabs.map((tab) => [tab.id, chatView!.tabLeafView(tab)]))
  }

  it('does not claim a pane whose agent has exited (R2a-F1)', async () => {
    const both = split('A', 'B', 'A')
    expect(
      await render([
        pane('A', { parentLayout: both, agentStatus: status('codex'), isActive: true }),
        pane('B', { parentLayout: both, agentStatus: status('claude') })
      ])
    ).toEqual({ 'T::A': 'chat', 'T::B': 'terminal' })
    // Claude exits on B: its status row goes, and B is a shell on the same PTY.
    await render([
      pane('A', { parentLayout: both, agentStatus: status('codex'), isActive: true }),
      pane('B', { parentLayout: both })
    ])
    // Pane A closes; B is the sole pane but has no live agent.
    const onlyB = { root: leaf('B'), activeLeafId: 'B' }
    expect(await render([pane('B', { parentLayout: onlyB, isActive: true })])).toEqual({
      'T::B': 'terminal'
    })
  })

  it('waits on readability for a transcript-gated agent instead of flashing terminal (R2a-F2)', async () => {
    const one = { root: leaf('A'), activeLeafId: 'A' }
    const tabs = [pane('A', { parentLayout: one, agentStatus: status('opencode'), isActive: true })]
    expect(await render(tabs, 'unknown')).toEqual({ 'T::A': 'undecided' })
    expect(await render(tabs, 'readable')).toEqual({ 'T::A': 'chat' })
  })

  it('returns to the pane it showed on after a failed switch (R2b-F2)', async () => {
    const agent = (active: string) =>
      pane('A', { parentLayout: split('A', 'N', active), launchAgent: 'claude', isActive: true })
    const shell = (active: string) => pane('N', { parentLayout: split('A', 'N', active) })
    expect(await render([agent('A'), shell('A')])).toEqual({ 'T::A': 'chat', 'T::N': 'terminal' })
    // Desktop focus moves to the shell pane; the chat stays where it was shown.
    expect(await render([agent('N'), shell('N')])).toEqual({ 'T::A': 'chat', 'T::N': 'terminal' })
    act(() => chatView!.setTabChatView('T::A', 'terminal'))
    expect(await render([agent('N'), shell('N')])).toEqual({
      'T::A': 'terminal',
      'T::N': 'terminal'
    })
    fails.at(-1)!(new Error('boom'))
    expect(await render([agent('N'), shell('N')])).toEqual({ 'T::A': 'chat', 'T::N': 'terminal' })
    expect(toasts).toHaveLength(1)
  })
})
