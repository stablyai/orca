// @vitest-environment happy-dom
import { createElement, type Dispatch, type SetStateAction } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftKeyboardState } from '../platform/keyboard-occlusion'
import type { RouteHandoff } from '../navigation/route-handoff'

const harness = vi.hoisted(() => {
  const keyboard: SoftKeyboardState = { height: 0, visible: false }
  return {
    keyboard,
    notifyKeyboardVisibility: vi.fn<(visible: boolean) => void>(),
    notifyTerminalFrameHeight: vi.fn<(height: number) => void>(),
    setKeyboardHeight: vi.fn<Dispatch<SetStateAction<number>>>()
  }
})

vi.mock('../platform/keyboard-occlusion', () => ({
  useSoftKeyboard: (): SoftKeyboardState => harness.keyboard
}))
// The refit hook reaches the RPC client and the terminal handles; what this file measures is what
// the screen tells it about the keyboard, which is the two notifications above it.
vi.mock('../terminal/terminal-viewport-refit', () => ({
  useTerminalViewportRefit: () => ({
    notifyKeyboardVisibility: harness.notifyKeyboardVisibility,
    notifyTerminalFrameHeight: harness.notifyTerminalFrameHeight
  })
}))
vi.mock('../components/CustomKeyModal', () => ({ saveCustomKeys: () => Promise.resolve() }))
vi.mock('../worktree/last-visited-worktree-repo', () => ({ writeLastVisitedWorktree: () => {} }))

import { useMobileSessionKeyboardState } from './use-mobile-session-keyboard-state'

/** Every member the type carries, because this file is typechecked; only `push` is reached here,
 *  from the shortcuts sheet's "Manage shortcuts". */
const router: RouteHandoff = {
  back: () => {},
  canDismiss: () => false,
  canGoBack: () => false,
  dismiss: () => {},
  dismissAll: () => {},
  dismissTo: () => {},
  navigate: () => {},
  prefetch: () => {},
  push: () => {},
  reload: () => {},
  replace: () => {},
  setParams: () => {}
}

function Harness(): null {
  useMobileSessionKeyboardState({
    hostId: 'host-1',
    worktreeId: 'wt-1',
    router,
    connState: 'connected',
    terminals: [],
    terminalTextScale: 1,
    activeSessionTabId: null,
    tabLayoutsRef: { current: new Map() },
    tabStripRef: { current: null },
    tabStripOffsetRef: { current: 0 },
    tabStripViewportWidthRef: { current: 0 },
    tabStripContentWidthRef: { current: 0 },
    customKeys: [],
    setCustomKeys: () => {},
    setShowCustomKeyModal: () => {},
    setKeyboardHeight: harness.setKeyboardHeight,
    // Read only by the viewport refit, which is mocked above; present because the scope names them.
    activeHandleRef: { current: null },
    clientRef: { current: null },
    deviceTokenRef: { current: null },
    initializedHandlesRef: { current: new Set() },
    showNativeChatRef: { current: false },
    subscribeToTerminal: () => {},
    terminalFrameHeightRef: { current: 0 },
    terminalFrameWidth: 0,
    terminalRefs: { current: new Map() },
    unsubscribeTerminal: () => {},
    viewportMeasuredRef: { current: false },
    viewportRef: { current: null }
  })
  return null
}

async function mount(): Promise<ReactTestRenderer> {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(Harness))
  })
  if (rendered.tree === null) {
    throw new Error('the harness did not mount')
  }
  return rendered.tree
}

async function rerender(tree: ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.update(createElement(Harness))
  })
}

describe('what the session screen hears about the keyboard', () => {
  beforeEach(() => {
    harness.keyboard = { height: 0, visible: false }
    harness.notifyKeyboardVisibility.mockClear()
    harness.notifyTerminalFrameHeight.mockClear()
    harness.setKeyboardHeight.mockClear()
  })

  it('lifts by the height the seam reports and drops back when it closes', async () => {
    const tree = await mount()
    harness.keyboard = { height: 336, visible: true }
    await rerender(tree)
    expect(harness.setKeyboardHeight).toHaveBeenLastCalledWith(336)
    expect(harness.notifyKeyboardVisibility).toHaveBeenLastCalledWith(true)

    harness.keyboard = { height: 0, visible: false }
    await rerender(tree)
    expect(harness.setKeyboardHeight).toHaveBeenLastCalledWith(0)
    expect(harness.notifyKeyboardVisibility).toHaveBeenLastCalledWith(false)
  })

  it('holds the refit off on the page, where the keyboard is open and covers nothing', async () => {
    // Inside the shell the WebView is already shortened, so the seam reports no occlusion: the
    // dock needs no lift. Refitting on that height change would reflow the desktop PTY on every
    // keyboard open, which is the reflow the visibility flag exists to defer.
    const tree = await mount()
    harness.keyboard = { height: 0, visible: true }
    await rerender(tree)
    expect(harness.notifyKeyboardVisibility).toHaveBeenLastCalledWith(true)
    expect(harness.setKeyboardHeight.mock.calls.every(([height]) => height === 0)).toBe(true)
  })
})
