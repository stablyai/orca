import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalLiveInputFocusTimer,
  focusTerminalLiveInputTarget,
  getTerminalLiveSpecialKeyBytes,
  isTerminalLiveInputWithinByteLimit,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTarget,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'

function createTimerRef(): TerminalLiveInputFocusTimerRef {
  return { current: null }
}

function createFocusTarget(isFocused: () => boolean): TerminalLiveInputFocusTarget {
  return {
    blur: vi.fn(),
    focus: vi.fn(),
    isFocused
  }
}

describe('terminal live input', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['Escape', '\x1b'],
    ['Esc', '\x1b'],
    ['Tab', '\t'],
    ['Backspace', '\x7f'],
    ['Delete', '\x1b[3~'],
    ['Insert', '\x1b[2~'],
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['ArrowLeft', '\x1b[D'],
    ['ArrowRight', '\x1b[C'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['PageUp', '\x1b[5~'],
    ['PageDown', '\x1b[6~'],
    ['F1', '\x1bOP'],
    ['F2', '\x1bOQ'],
    ['F3', '\x1bOR'],
    ['F4', '\x1bOS'],
    ['F5', '\x1b[15~'],
    ['F6', '\x1b[17~'],
    ['F7', '\x1b[18~'],
    ['F8', '\x1b[19~'],
    ['F9', '\x1b[20~'],
    ['F10', '\x1b[21~'],
    ['F11', '\x1b[23~'],
    ['F12', '\x1b[24~']
  ])('maps %s to terminal escape bytes', (key, bytes) => {
    expect(getTerminalLiveSpecialKeyBytes(key)).toBe(bytes)
  })

  it('leaves submitted or printable keys on their existing input paths', () => {
    expect(getTerminalLiveSpecialKeyBytes('Enter')).toBeNull()
    expect(getTerminalLiveSpecialKeyBytes('a')).toBeNull()
  })

  it('ignores object prototype names from native key events', () => {
    expect(getTerminalLiveSpecialKeyBytes('constructor')).toBeNull()
    expect(getTerminalLiveSpecialKeyBytes('toString')).toBeNull()
    expect(getTerminalLiveSpecialKeyBytes('hasOwnProperty')).toBeNull()
  })

  it('enforces the paste-sized byte budget', () => {
    expect(isTerminalLiveInputWithinByteLimit('hello')).toBe(true)
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(262_144))).toBe(true)
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(262_144 + 1))).toBe(false)
    expect(isTerminalLiveInputWithinByteLimit('é'.repeat(262_144 / 2 + 1))).toBe(false)
  })

  it('replaces pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const staleFocus = vi.fn()
    const nextFocus = vi.fn()

    scheduleTerminalLiveInputFocus(timerRef, staleFocus)
    scheduleTerminalLiveInputFocus(timerRef, nextFocus)
    vi.runOnlyPendingTimers()

    expect(staleFocus).not.toHaveBeenCalled()
    expect(nextFocus).toHaveBeenCalledTimes(1)
    expect(timerRef.current).toBeNull()
  })

  it('clears pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const focus = vi.fn()

    scheduleTerminalLiveInputFocus(timerRef, focus)
    clearTerminalLiveInputFocusTimer(timerRef)
    vi.runOnlyPendingTimers()

    expect(focus).not.toHaveBeenCalled()
    expect(timerRef.current).toBeNull()
  })

  it('refocuses an already-focused capture input when the keyboard is closed', () => {
    const input = createFocusTarget(() => true)
    const refocus = vi.fn()

    focusTerminalLiveInputTarget(input, {
      keyboardHeight: 0,
      refocus,
      reopenFocusedInputWhenKeyboardHidden: true
    })

    expect(input.blur).toHaveBeenCalledTimes(1)
    expect(input.focus).not.toHaveBeenCalled()
    expect(refocus).toHaveBeenCalledTimes(1)
  })
  it('keeps an iPad hardware-keyboard responder focused when the software keyboard is absent', () => {
    const input = createFocusTarget(() => true)
    const refocus = vi.fn()

    focusTerminalLiveInputTarget(input, {
      keyboardHeight: 0,
      refocus,
      reopenFocusedInputWhenKeyboardHidden: false
    })

    expect(input.blur).not.toHaveBeenCalled()
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(refocus).not.toHaveBeenCalled()
  })

  it('focuses the capture input directly when the keyboard is open', () => {
    const input = createFocusTarget(() => true)
    const refocus = vi.fn()

    focusTerminalLiveInputTarget(input, {
      keyboardHeight: 240,
      refocus,
      reopenFocusedInputWhenKeyboardHidden: true
    })

    expect(input.blur).not.toHaveBeenCalled()
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(refocus).not.toHaveBeenCalled()
  })

  it('focuses the capture input directly when it is not already focused', () => {
    const input = createFocusTarget(() => false)
    const refocus = vi.fn()

    focusTerminalLiveInputTarget(input, {
      keyboardHeight: 0,
      refocus,
      reopenFocusedInputWhenKeyboardHidden: true
    })

    expect(input.blur).not.toHaveBeenCalled()
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(refocus).not.toHaveBeenCalled()
  })
})
