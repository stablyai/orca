// @vitest-environment happy-dom
import { createElement, type Dispatch, type SetStateAction } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftKeyboardState } from '../platform/keyboard-occlusion'
import type { RouteHandoff } from '../navigation/route-handoff'
import type { CustomKey } from '../terminal/terminal-custom-keys'

const harness = vi.hoisted(() => {
  const keyboard: SoftKeyboardState = { height: 0, visible: false }
  const deleteCustomKey: { current: ((key: CustomKey) => Promise<void>) | null } = {
    current: null
  }
  return {
    keyboard,
    deleteCustomKey,
    notifyKeyboardVisibility: vi.fn<(visible: boolean) => void>(),
    notifyTerminalFrameHeight: vi.fn<(height: number) => void>(),
    setKeyboardHeight: vi.fn<Dispatch<SetStateAction<number>>>(),
    setCustomKeys: vi.fn<Dispatch<SetStateAction<CustomKey[]>>>(),
    removeCustomKey: vi.fn<(id: string) => Promise<CustomKey[]>>()
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
vi.mock('../terminal/terminal-custom-keys', () => ({ removeCustomKey: harness.removeCustomKey }))
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
  const { handleDeleteCustomKey } = useMobileSessionKeyboardState({
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
    setCustomKeys: harness.setCustomKeys,
    setShowCustomKeyModal: () => {},
    setKeyboardHeight: harness.setKeyboardHeight,
    // Read only by the viewport refit, which is mocked above; present because the scope names them.
    activeHandleRef: { current: null },
    clientRef: { current: null },
    deviceTokenRef: { current: null },
    showNativeChatRef: { current: false },
    subscribeToTerminal: () => {},
    terminalFrameRef: { current: null },
    terminalRefs: { current: new Map() },
    unsubscribeTerminal: () => {},
    viewportMeasuredRef: { current: false },
    viewportRef: { current: null }
  })
  harness.deleteCustomKey.current = handleDeleteCustomKey
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

  it('holds the refit off for a keyboard that is open and covers nothing', async () => {
    // A floating keyboard reports no occlusion, so the dock needs no lift. Refitting on that height
    // change would reflow the desktop PTY on every keyboard open, which is the reflow the
    // visibility flag exists to defer.
    const tree = await mount()
    harness.keyboard = { height: 0, visible: true }
    await rerender(tree)
    expect(harness.notifyKeyboardVisibility).toHaveBeenLastCalledWith(true)
    expect(harness.setKeyboardHeight.mock.calls.every(([height]) => height === 0)).toBe(true)
  })
})

describe('removing a custom shortcut from the session sheet', () => {
  const key: CustomKey = { id: 'custom-1', label: 'Ctrl+C', bytes: '\u0003', enter: false }

  beforeEach(() => {
    harness.setCustomKeys.mockClear()
    harness.removeCustomKey.mockReset()
  })

  it('keeps the key on screen when the store refuses the removal', async () => {
    harness.removeCustomKey.mockRejectedValue(new Error('refused'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mount()
    await act(async () => {
      await harness.deleteCustomKey.current?.(key)
    })
    expect(harness.setCustomKeys).not.toHaveBeenCalled()
  })

  it('shows the list the store took once the removal lands', async () => {
    harness.removeCustomKey.mockResolvedValue([])
    await mount()
    await act(async () => {
      await harness.deleteCustomKey.current?.(key)
    })
    expect(harness.removeCustomKey).toHaveBeenCalledWith('custom-1')
    expect(harness.setCustomKeys).toHaveBeenCalledWith([])
  })
})
