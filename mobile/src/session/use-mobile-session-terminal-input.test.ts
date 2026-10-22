import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Keyboard: { dismiss: vi.fn() } }))

import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

type InputNode = {
  focus: ReturnType<typeof vi.fn>
  blur: ReturnType<typeof vi.fn>
  isFocused: () => boolean
}

function inputNode(focused: boolean): InputNode {
  return {
    focus: vi.fn(),
    blur: vi.fn(),
    isFocused: () => focused
  }
}

function mountToggle(options: {
  keyboardHeight?: number
  nextEnabled: boolean
  liveFocused?: boolean
  commandFocused?: boolean
}) {
  const live = inputNode(options.liveFocused ?? false)
  const command = inputNode(options.commandFocused ?? false)
  const toggleTerminalLiveInput = vi.fn(() => options.nextEnabled)
  let toggleLiveInput: (() => void) | undefined
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    const model = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: toggleLiveInput reads only these members; the rest of the session model stays unused.
      {
        activeHandle: 'terminal-1',
        clearPendingLiveInputCommit: vi.fn(),
        commandInputRef: { current: command },
        keyboardHeight: options.keyboardHeight ?? 0,
        liveInputFocusTimerRef: { current: null },
        liveInputRef: { current: live },
        toggleTerminalLiveInput
      } as never
    )
    toggleLiveInput = model.toggleLiveInput
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!toggleLiveInput) {
    throw new Error('toggleLiveInput did not mount')
  }
  const toggle = toggleLiveInput

  return {
    command,
    live,
    toggle() {
      act(() => {
        toggle()
      })
    },
    unmount() {
      act(() => renderer?.unmount())
    }
  }
}

describe('toggleLiveInput keyboard handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('focuses live input immediately and on the scheduled retry when the keyboard is open', () => {
    const harness = mountToggle({ keyboardHeight: 320, nextEnabled: true })

    harness.toggle()

    expect(harness.live.focus).toHaveBeenCalledTimes(1)
    expect(harness.live.blur).not.toHaveBeenCalled()
    expect(harness.command.focus).not.toHaveBeenCalled()
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(harness.live.focus).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('focuses live input immediately when the command field is focused and the keyboard height is still 0', () => {
    const harness = mountToggle({ commandFocused: true, keyboardHeight: 0, nextEnabled: true })

    harness.toggle()

    expect(harness.live.focus).toHaveBeenCalledTimes(1)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(harness.live.focus).toHaveBeenCalledTimes(2)
    expect(harness.command.focus).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('keeps the keyboard by focusing the command field instead of blurring live input', () => {
    const harness = mountToggle({ keyboardHeight: 320, nextEnabled: false })

    harness.toggle()

    expect(harness.live.blur).not.toHaveBeenCalled()
    expect(harness.live.focus).not.toHaveBeenCalled()
    expect(harness.command.focus).toHaveBeenCalledTimes(1)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(harness.command.focus).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('focuses the command field when live input is focused and the keyboard height is still 0', () => {
    const harness = mountToggle({ keyboardHeight: 0, liveFocused: true, nextEnabled: false })

    harness.toggle()

    expect(harness.live.blur).not.toHaveBeenCalled()
    expect(harness.command.focus).toHaveBeenCalledTimes(1)
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(harness.command.focus).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('blurs live input when the keyboard is closed and neither field is focused', () => {
    const harness = mountToggle({ keyboardHeight: 0, nextEnabled: false })

    harness.toggle()

    expect(harness.live.blur).toHaveBeenCalledTimes(1)
    expect(harness.command.focus).not.toHaveBeenCalled()
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(harness.command.focus).not.toHaveBeenCalled()
    expect(harness.live.focus).not.toHaveBeenCalled()
    harness.unmount()
  })
})
