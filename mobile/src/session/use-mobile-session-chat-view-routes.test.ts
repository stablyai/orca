import { createElement, useLayoutEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  mobileChatPairKeysInScope,
  readMobileChatPairOverlay
} from './mobile-session-chat-pair-writes'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  useMobileSessionChatView,
  type MobileSessionChatView
} from './use-mobile-session-chat-view'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../storage/session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  loadDefaultSessionView: vi.fn(async () => 'terminal'),
  saveDefaultSessionView: vi.fn(async () => {}),
  readSessionViewOverridesPreference: vi.fn(async () => ({ overrides: new Map(), loaded: true })),
  updateSessionViewOverride: vi.fn(async () => {})
}))

type TerminalRow = Extract<MobileSessionTab, { type: 'terminal' }>
type Screen = { tabs: MobileSessionTab[]; marker: boolean; accepted: boolean }

const sole: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'A' }
const row = (overrides: Partial<TerminalRow> = {}): TerminalRow => ({
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
})

const settles: ((response: RpcResponse) => void)[] = []
const toasts: string[] = []
const views: Record<string, MobileSessionChatView> = {}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat view reaches the client only through sendRequest and its connection state.
const client = {
  sendRequest: vi.fn(() => new Promise<RpcResponse>((settle) => settles.push(settle))),
  getState: () => 'connected'
} as unknown as RpcClient

function Route(props: Screen & { name: string }): null {
  const tabsRef = useRef(props.tabs)
  // Why layout: the hook reads this ref only after commit, from effects and taps.
  useLayoutEffect(() => {
    tabsRef.current = props.tabs
  })
  views[props.name] = useMobileSessionChatView({
    hostId: 'h-routes',
    worktreeId: 'w',
    client,
    sessionTabs: props.tabs,
    sessionTabsRef: tabsRef,
    markerSession: props.marker,
    snapshotAccepted: props.accepted,
    readability: 'readable',
    onSwitchUnconfirmed: (message) => toasts.push(message)
  })
  return null
}

function App(props: { pushed: Screen | null }) {
  return [
    createElement(Route, { key: 'a', name: 'a', tabs: [row()], marker: true, accepted: true }),
    props.pushed ? createElement(Route, { key: 'b', name: 'b', ...props.pushed }) : null
  ]
}

describe('a session screen pushed over another for the same worktree (history -> resume) (R2b-F1)', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function show(pushed: Screen | null): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(App, { pushed }))
      } else {
        renderer = create(createElement(App, { pushed }))
      }
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve()
      }
    })
  }

  it("keeps the first screen's in-flight switch until the pushed one has its own snapshot", async () => {
    await show(null)
    act(() => views.a!.setTabChatView('P::A', 'chat'))
    // Every screen starts with no rows and no marker before its first snapshot.
    await show({ tabs: [], marker: false, accepted: false })
    expect(mobileChatPairKeysInScope('h-routes', 'w')).toHaveLength(1)
    expect(readMobileChatPairOverlay().size).toBe(1)

    // The reply reads the host pair through the screen that has rows, not the empty one.
    settles[0]!({
      id: 'reply',
      ok: true,
      result: { updated: true, chatView: { viewMode: 'chat', chatLeafId: 'A' } },
      _meta: { runtimeId: 'r' }
    })
    await show({ tabs: [], marker: false, accepted: false })
    expect(mobileChatPairKeysInScope('h-routes', 'w')).toHaveLength(1)

    // Its first accepted snapshot is no marker flip; it retires the switch the host now shows.
    const chosen = row({ viewMode: 'chat', parentLayout: { root: sole, chatLeafId: 'A' } })
    await show({ tabs: [chosen], marker: true, accepted: true })
    expect(mobileChatPairKeysInScope('h-routes', 'w')).toEqual([])
    expect(views.b!.isTabChatView('P::A')).toBe(true)
    expect(toasts).toEqual([])
  })
})
