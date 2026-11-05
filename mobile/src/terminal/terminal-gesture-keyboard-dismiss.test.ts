import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import type {
  TerminalLiveInputFocusTarget,
  TerminalLiveInputFocusTimerRef
} from './terminal-live-input'
import { useTerminalLiveInputFocus } from './use-terminal-live-input-focus'

describe('terminal gesture keyboard dismiss', () => {
  function mount(keyboardHeight: number, dismissKeyboard: () => void) {
    const activeHandleRef: RefObject<string | null> = { current: 'terminal-a' }
    const timerRef: TerminalLiveInputFocusTimerRef = { current: null }
    let focused = true
    const input = {
      blur: vi.fn(() => {
        focused = false
      }),
      focus: vi.fn(() => {
        focused = true
      }),
      isFocused: () => focused
    }
    const inputRef: RefObject<TerminalLiveInputFocusTarget | null> = { current: input }
    let handlers: ReturnType<typeof useTerminalLiveInputFocus> | null = null
    let renderer: ReactTestRenderer | null = null

    function Harness(props: { readonly keyboardHeight: number }): null {
      handlers = useTerminalLiveInputFocus({
        activeHandleRef,
        canSend: true,
        dismissKeyboard,
        inputRef,
        keyboardHeight: props.keyboardHeight,
        lifecycleIdentity: null,
        lifecycleKey: 'host-a:connected',
        reopenFocusedInputWhenKeyboardHidden: true,
        timerRef
      })
      return null
    }

    act(() => {
      renderer = create(createElement(Harness, { keyboardHeight }))
    })
    if (!handlers || !renderer) {
      throw new Error('gesture dismiss harness did not render')
    }
    return {
      handlers: () => {
        if (!handlers) {
          throw new Error('gesture dismiss harness is not mounted')
        }
        return handlers
      },
      input,
      timerRef,
      unmount: () => {
        act(() => renderer?.unmount())
      },
      render: (nextHeight: number) => {
        act(() => renderer?.update(createElement(Harness, { keyboardHeight: nextHeight })))
      }
    }
  }

  it('puts the keyboard away on a tap instead of refocusing the live input', () => {
    const dismissKeyboard = vi.fn()
    const harness = mount(320, dismissKeyboard)
    harness.handlers().handleTerminalTap('terminal-a')
    expect(dismissKeyboard).toHaveBeenCalledTimes(1)
    expect(harness.input.blur).toHaveBeenCalled()
    expect(harness.input.focus).not.toHaveBeenCalled()
    expect(harness.timerRef.current).toBeNull()
    harness.unmount()
  })

  it('puts the keyboard away on a downward swipe, and only while it is up', () => {
    const dismissKeyboard = vi.fn()
    const harness = mount(0, dismissKeyboard)
    harness.handlers().handleTerminalSwipeDown('terminal-a')
    expect(dismissKeyboard).not.toHaveBeenCalled()
    harness.render(320)
    harness.handlers().handleTerminalSwipeDown('terminal-a')
    expect(dismissKeyboard).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('ignores gestures from a pane that is not the active terminal', () => {
    const dismissKeyboard = vi.fn()
    const harness = mount(320, dismissKeyboard)
    harness.handlers().handleTerminalTap('terminal-b')
    harness.handlers().handleTerminalSwipeDown('terminal-b')
    expect(dismissKeyboard).not.toHaveBeenCalled()
    harness.unmount()
  })
})
