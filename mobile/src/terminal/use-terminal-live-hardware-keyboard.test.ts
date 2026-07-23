import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalLiveHardwareKeyboard } from './use-terminal-live-hardware-keyboard'
import type { TerminalLiveInputFocusTimerRef } from './terminal-live-input'

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

describe('useTerminalLiveHardwareKeyboard soft focus latch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Given live mode is enabling When soft focus is requested first Then focuses after enabled and latched', async () => {
    vi.useFakeTimers()
    const focus = vi.fn()
    const blur = vi.fn()
    const isFocused = vi.fn(() => false)
    const liveInputRef: RefObject<TextInput | null> = {
      current: { focus, blur, isFocused } as unknown as TextInput
    }
    const liveInputFocusTimerRef: TerminalLiveInputFocusTimerRef = { current: null }
    let api: ReturnType<typeof useTerminalLiveHardwareKeyboard> | null = null
    let liveInputEnabled = false
    let renderer: ReactTestRenderer | null = null

    function Harness(): null {
      api = useTerminalLiveHardwareKeyboard({
        focusScopeKey: 'terminal-a',
        liveInputEnabled,
        canSend: true,
        liveInputRef,
        liveInputFocusTimerRef,
        modalOpen: false,
        handleLiveInputHardwareKey: () => {}
      })
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restore()
    }
    if (!api || !renderer) {
      throw new Error('hardware keyboard hook did not render')
    }

    expect(api.showSoftInputOnFocus).toBe(false)

    act(() => {
      api?.requestSoftKeyboardFocus()
    })

    // The toggle has not re-rendered enabled yet, so the focus remains pending.
    expect(api.showSoftInputOnFocus).toBe(false)
    expect(focus).not.toHaveBeenCalled()

    liveInputEnabled = true
    act(() => renderer?.update(createElement(Harness)))

    // Latch is now active, but focus is deferred until after the prop commits.
    expect(api.showSoftInputOnFocus).toBe(true)
    expect(focus).not.toHaveBeenCalled()

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(focus).toHaveBeenCalled()
    expect(blur).not.toHaveBeenCalled()
  })

  it('Given a modal blurred input When it closes Then only a terminal switch restores silent focus', async () => {
    vi.useFakeTimers()
    const focus = vi.fn()
    const liveInputRef: RefObject<TextInput | null> = {
      current: {
        focus,
        blur: vi.fn(),
        isFocused: vi.fn(() => false)
      } as unknown as TextInput
    }
    const liveInputFocusTimerRef: TerminalLiveInputFocusTimerRef = { current: null }
    let modalOpen = true
    let focusScopeKey = 'terminal-a'
    let api: ReturnType<typeof useTerminalLiveHardwareKeyboard> | null = null
    let renderer: ReactTestRenderer | null = null

    function Harness(): null {
      api = useTerminalLiveHardwareKeyboard({
        focusScopeKey,
        liveInputEnabled: true,
        canSend: true,
        liveInputRef,
        liveInputFocusTimerRef,
        modalOpen,
        handleLiveInputHardwareKey: () => {}
      })
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restore()
    }
    if (!renderer) {
      throw new Error('hardware keyboard hook did not render')
    }
    expect(api?.hardwareCaptureEnabled).toBe(false)

    modalOpen = false
    act(() => renderer?.update(createElement(Harness)))
    await act(async () => vi.runAllTimersAsync())
    expect(api?.hardwareCaptureEnabled).toBe(true)
    expect(focus).not.toHaveBeenCalled()

    focusScopeKey = 'terminal-b'
    act(() => renderer?.update(createElement(Harness)))
    await act(async () => vi.runAllTimersAsync())
    expect(focus).toHaveBeenCalledOnce()
  })

  it('Given native events race a modal or disabled state When received Then JS rejects stale capture', () => {
    const handleLiveInputHardwareKey = vi.fn()
    const liveInputRef: RefObject<TextInput | null> = {
      current: {
        focus: vi.fn(),
        blur: vi.fn(),
        isFocused: vi.fn(() => true)
      } as unknown as TextInput
    }
    const liveInputFocusTimerRef: TerminalLiveInputFocusTimerRef = { current: null }
    let modalOpen = true
    let canSend = true
    let api: ReturnType<typeof useTerminalLiveHardwareKeyboard> | null = null
    let renderer: ReactTestRenderer | null = null

    function Harness(): null {
      api = useTerminalLiveHardwareKeyboard({
        focusScopeKey: 'terminal-a',
        liveInputEnabled: true,
        canSend,
        liveInputRef,
        liveInputFocusTimerRef,
        modalOpen,
        handleLiveInputHardwareKey
      })
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restore()
    }
    if (!api || !renderer) {
      throw new Error('hardware keyboard hook did not render')
    }
    const event = {
      nativeEvent: {
        key: 'ArrowLeft',
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        repeat: false
      }
    }

    api.onHardwareKey(event)
    expect(handleLiveInputHardwareKey).not.toHaveBeenCalled()

    modalOpen = false
    act(() => renderer?.update(createElement(Harness)))
    api.onHardwareKey(event)
    expect(handleLiveInputHardwareKey).toHaveBeenCalledOnce()

    canSend = false
    act(() => renderer?.update(createElement(Harness)))
    api.onHardwareKey(event)
    expect(handleLiveInputHardwareKey).toHaveBeenCalledOnce()
  })
})
