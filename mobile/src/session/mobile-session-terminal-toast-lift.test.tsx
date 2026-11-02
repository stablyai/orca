import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => null }))
vi.mock('../layout/use-shell-side-rail', () => ({
  useShellSideRail: () => false,
  useDirectionPadAvailable: () => false
}))

import { useMobileSessionPresentation } from './use-mobile-session-presentation'

type Presentation = ReturnType<typeof useMobileSessionPresentation>

const KEYBOARD_HEIGHT = 300

function present(options: {
  resizeForKeyboard: boolean
  showNativeChat: boolean
  displayMode?: 'auto' | 'phone' | 'desktop'
  splitOtherMode?: 'phone' | 'desktop'
}): Presentation {
  const scope = {
    created: undefined,
    worktreeId: 'wt-1',
    router: { setParams: () => {} },
    insets: { top: 0, bottom: 24, left: 0, right: 0 },
    connState: 'reconnecting',
    client: null,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    terminalsLoaded: true,
    activeHandle: 'term-1',
    creating: false,
    creatingBrowser: false,
    creatingMarkdown: false,
    keyboardHeight: KEYBOARD_HEIGHT,
    terminalKeyboardResizeEnabled: options.resizeForKeyboard,
    showNativeChat: options.showNativeChat,
    terminalKeyboardMetrics: new Map(),
    terminalModes: new Map([
      ['term-1', options.displayMode ?? 'auto'],
      ['term-2', options.splitOtherMode ?? 'auto']
    ]),
    terminalSplitActive: options.splitOtherMode !== undefined,
    visibleTerminalHandles: ['term-1', 'term-2'],
    toastOpacityRef: { current: 1 },
    hostEndpoint: null,
    initialSessionAutoCreateRef: { current: null },
    terminalFrameRef: { current: { width: 400, height: 600 } },
    handleCreateTerminal: () => Promise.resolve(),
    visibleTabs: [],
    forceReconnectHost: null
  }
  type Scope = Parameters<typeof useMobileSessionPresentation>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the presentation hook reads only these members of the session scope; the rest of the controller is unreachable from it.
  const sessionScope = scope as unknown as Scope
  const read: { value: Presentation | null } = { value: null }
  function Probe(): null {
    read.value = useMobileSessionPresentation(sessionScope)
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  if (read.value === null) {
    throw new Error('the hook did not run')
  }
  return read.value
}

function liftOf(style: Presentation['toastAnimatedStyle']): number {
  return -style.transform[0].translateY
}

describe('toast lift while the Android keyboard is open', () => {
  it('lifts every toast by the keyboard when the terminal slides under it', () => {
    const view = present({ resizeForKeyboard: false, showNativeChat: false })
    expect(liftOf(view.toastAnimatedStyle)).toBe(KEYBOARD_HEIGHT)
    expect(liftOf(view.terminalToastAnimatedStyle)).toBe(KEYBOARD_HEIGHT)
  })

  it('does not lift the terminal toast again once the dock already shrank the terminal', () => {
    const view = present({ resizeForKeyboard: true, showNativeChat: false })
    expect(liftOf(view.terminalToastAnimatedStyle)).toBe(0)
    expect(view.activeTerminalKeyboardLift).toBe(0)
    // Markdown, file and browser frames have no dock, so their toast still clears the keyboard.
    expect(liftOf(view.toastAnimatedStyle)).toBe(KEYBOARD_HEIGHT)
  })

  it('keeps the full lift under native chat, which hides the dock', () => {
    const view = present({ resizeForKeyboard: true, showNativeChat: true })
    expect(liftOf(view.terminalToastAnimatedStyle)).toBe(KEYBOARD_HEIGHT)
  })

  it('keeps the lift when the desktop holds the dims, because the host will not resize the PTY', () => {
    const view = present({ resizeForKeyboard: true, showNativeChat: false, displayMode: 'desktop' })
    expect(view.activeTerminalKeyboardLift).not.toBe(0)
    expect(liftOf(view.terminalToastAnimatedStyle)).toBe(KEYBOARD_HEIGHT)
  })

  it('still disables the lift while the phone drives at an explicit phone mode', () => {
    const view = present({ resizeForKeyboard: true, showNativeChat: false, displayMode: 'phone' })
    expect(view.activeTerminalKeyboardLift).toBe(0)
    expect(liftOf(view.terminalToastAnimatedStyle)).toBe(0)
  })

  it.each(['phone', 'desktop'] as const)(
    'resizes split panes only when the other pane also uses phone dimensions (%s)',
    (splitOtherMode) => {
      const view = present({ resizeForKeyboard: true, showNativeChat: false, splitOtherMode })
      expect(view.terminalKeyboardResizeActive).toBe(splitOtherMode === 'phone')
      expect(liftOf(view.terminalToastAnimatedStyle)).toBe(
        splitOtherMode === 'phone' ? 0 : KEYBOARD_HEIGHT
      )
    }
  )
})
