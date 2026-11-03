import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('react-native', () => ({
  Keyboard: {
    dismiss: vi.fn(),
    addListener: () => ({ remove: () => {} })
  }
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn() }))
vi.mock('../platform/keyboard-occlusion', () => ({
  currentSoftKeyboardHeight: () => 0
}))

import { useTerminalLiveInputFocus } from '../terminal/use-terminal-live-input-focus'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

function mountSendActions(overrides: Partial<MobileSessionTerminalWebviewModel>) {
  let latest!: ReturnType<typeof useMobileSessionTerminalSendActions>
  const sendTerminalUserInput = vi.fn().mockResolvedValue({
    id: '1',
    ok: true,
    result: { send: { accepted: true } }
  })
  const handleLiveInputAccessoryBytes = vi.fn().mockResolvedValue({ kind: 'allow-raw' as const })
  const handleTerminalInteraction = vi.fn()
  const client = mountFixture<NonNullable<MobileSessionTerminalWebviewModel['client']>>({})
  const liveInputFocusTimerRef = { current: null as ReturnType<typeof setTimeout> | null }

  function Probe(props: { scope: MobileSessionTerminalWebviewModel }) {
    latest = useMobileSessionTerminalSendActions(props.scope)
    return null
  }

  const baseScope = mountFixture<MobileSessionTerminalWebviewModel>({
    client,
    clientRef: { current: client },
    connStateRef: { current: 'connected' },
    deviceTokenRef: { current: 'dev-1' },
    activeHandle: 'term-1',
    activeHandleRef: { current: 'term-1' },
    activeSessionTab: {
      id: 'tab-1',
      type: 'terminal',
      title: 'agy',
      terminal: 'term-1',
      agentStatus: { agentType: 'antigravity', state: 'working' }
    },
    activeSessionTabTypeRef: { current: 'terminal' },
    visibleTerminalHandlesRef: { current: ['term-1'] },
    tripleTapEnterEnabled: true,
    canSend: true,
    ptyModesRef: { current: new Map() },
    terminalRefs: { current: new Map() },
    liveInputRef: { current: null },
    liveInputFocusTimerRef,
    sendLiveTerminalInputRef: { current: vi.fn() },
    sessionTabActionSheetKeyboardHideSubRef: { current: null },
    sessionTabActionSheetRequestSeqRef: { current: 0 },
    keyboardHeight: 0,
    getSendCompletionGeneration: () => 1,
    getLiveInteractionGeneration: () => 1,
    handleLiveInputAccessoryBytes,
    handleLiveInputSubmit: vi.fn().mockResolvedValue(true),
    handleTerminalInteraction,
    sendTerminalUserInput,
    sendTerminalOrderedInput: sendTerminalUserInput,
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    ...overrides
  })

  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe, { scope: baseScope }))
  })
  return {
    get actions() {
      return latest
    },
    sendTerminalUserInput,
    handleLiveInputAccessoryBytes,
    handleTerminalInteraction,
    liveInputFocusTimerRef,
    unmount: () => {
      act(() => {
        renderer.unmount()
      })
    }
  }
}

describe('handleTerminalTripleTap', () => {
  it('sends raw Enter when live input allows raw accessory bytes', async () => {
    const harness = mountSendActions({})
    try {
      const focusCallback = vi.fn()
      harness.liveInputFocusTimerRef.current = setTimeout(focusCallback, 50)

      await act(async () => {
        await harness.actions.handleTerminalTripleTap('term-1')
      })

      expect(harness.liveInputFocusTimerRef.current).toBeNull()
      expect(harness.handleTerminalInteraction).toHaveBeenCalledWith('term-1')
      expect(harness.handleLiveInputAccessoryBytes).toHaveBeenCalledWith({ bytes: '\r' })
      expect(harness.sendTerminalUserInput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ terminal: 'term-1', text: '\r', enter: false }),
        expect.anything()
      )
    } finally {
      harness.unmount()
    }
  })

  it('flushes live input and sends Enter when live input handles the accessory key', async () => {
    const handleLiveInputAccessoryBytes = vi.fn().mockResolvedValue({ kind: 'handled' as const })
    const harness = mountSendActions({
      handleLiveInputAccessoryBytes
    })
    try {
      await act(async () => {
        await harness.actions.handleTerminalTripleTap('term-1')
      })

      expect(handleLiveInputAccessoryBytes).toHaveBeenCalledWith({ bytes: '\r' })
      expect(harness.sendTerminalUserInput).not.toHaveBeenCalled()
    } finally {
      harness.unmount()
    }
  })

  it('ignores triple taps when disabled in settings', async () => {
    const harness = mountSendActions({ tripleTapEnterEnabled: false })
    try {
      await act(async () => {
        await harness.actions.handleTerminalTripleTap('term-1')
      })

      expect(harness.handleTerminalInteraction).not.toHaveBeenCalled()
      expect(harness.sendTerminalUserInput).not.toHaveBeenCalled()
    } finally {
      harness.unmount()
    }
  })

  it('defers hidden-keyboard tap focus across the 420ms multi-tap settle window so 3 taps never open the keyboard', async () => {
    vi.useFakeTimers()
    const focus = vi.fn()
    const blur = vi.fn()
    const liveInputRef = { current: { focus, blur } as never }
    const activeHandleRef = { current: 'term-1' as string | null }
    const liveInputFocusTimerRef = { current: null as ReturnType<typeof setTimeout> | null }
    let tapFocus!: ReturnType<typeof useTerminalLiveInputFocus>

    function FocusProbe() {
      tapFocus = useTerminalLiveInputFocus({
        activeHandleRef,
        canSend: true,
        hiddenKeyboardTapFocusDelayMs: 420,
        inputRef: liveInputRef,
        lifecycleIdentity: null,
        lifecycleKey: 'k1',
        reopenFocusedInputWhenKeyboardHidden: true,
        timerRef: liveInputFocusTimerRef
      })
      return null
    }

    const harness = mountSendActions({ activeHandleRef, liveInputRef, liveInputFocusTimerRef })
    let focusRenderer!: ReturnType<typeof create>
    act(() => {
      focusRenderer = create(createElement(FocusProbe))
    })

    try {
      act(() => {
        tapFocus.handleTerminalTap('term-1')
        vi.advanceTimersByTime(180)
        tapFocus.handleTerminalTap('term-1')
        vi.advanceTimersByTime(180)
      })
      expect(focus).not.toHaveBeenCalled()

      await act(async () => {
        await harness.actions.handleTerminalTripleTap('term-1')
        vi.advanceTimersByTime(1000)
      })
      expect(focus).not.toHaveBeenCalled()
      expect(harness.sendTerminalUserInput).toHaveBeenCalledTimes(1)

      // A standalone single tap still opens the keyboard once the 420ms settle window elapses.
      act(() => {
        tapFocus.handleTerminalTap('term-1')
        vi.advanceTimersByTime(419)
      })
      expect(focus).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      act(() => {
        focusRenderer.unmount()
      })
      harness.unmount()
      vi.useRealTimers()
    }
  })
})
