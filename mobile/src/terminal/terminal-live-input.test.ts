import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_LIVE_INPUT_MAX_BYTES,
  applyDisabledTerminalLiveInputHandles,
  clearTerminalLiveInputFocusTimer,
  defaultTerminalLiveInputHandles,
  filterTerminalLiveInputDefaultCandidates,
  getTerminalLiveSpecialKeyBytes,
  isTerminalLiveInputWithinByteLimit,
  pruneTerminalLiveInputHandles,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'

function createTimerRef(): TerminalLiveInputFocusTimerRef {
  return { current: null }
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
  ])('maps %s to terminal PTY bytes', (key, bytes) => {
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
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES))).toBe(true)
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES + 1))).toBe(
      false
    )
    expect(
      isTerminalLiveInputWithinByteLimit('é'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES / 2 + 1))
    ).toBe(false)
  })

  it('defaults first-seen terminal handles to live input once', () => {
    const firstPass = defaultTerminalLiveInputHandles(new Set(), new Set(), ['pty-1'])

    expect(firstPass.changed).toBe(true)
    expect([...firstPass.enabledHandles]).toEqual(['pty-1'])
    expect([...firstPass.defaultedHandles]).toEqual(['pty-1'])

    const manuallyDisabled = new Set<string>()
    const secondPass = defaultTerminalLiveInputHandles(
      manuallyDisabled,
      firstPass.defaultedHandles,
      ['pty-1', 'pty-2']
    )

    expect(secondPass.changed).toBe(true)
    expect([...secondPass.enabledHandles]).toEqual(['pty-2'])
    expect([...secondPass.defaultedHandles]).toEqual(['pty-1', 'pty-2'])
  })

  it('does not allocate new live input sets when no handles need defaults', () => {
    const enabled = new Set(['pty-1'])
    const defaulted = new Set(['pty-1'])
    const result = defaultTerminalLiveInputHandles(enabled, defaulted, ['pty-1'])

    expect(result.changed).toBe(false)
    expect(result.enabledHandles).toBe(enabled)
    expect(result.defaultedHandles).toBe(defaulted)
  })

  it('does not default persisted buffered-mode handles back to live input on reentry', () => {
    const defaultableHandles = filterTerminalLiveInputDefaultCandidates(
      ['pty-1', 'pty-2'],
      new Set(['pty-1'])
    )

    const result = defaultTerminalLiveInputHandles(
      new Set(),
      new Set(['pty-1']),
      defaultableHandles
    )

    expect(defaultableHandles).toEqual(['pty-2'])
    expect([...result.enabledHandles]).toEqual(['pty-2'])
    expect([...result.defaultedHandles]).toEqual(['pty-1', 'pty-2'])
  })

  it('reconciles persisted buffered-mode handles with currently enabled live input', () => {
    const result = applyDisabledTerminalLiveInputHandles(
      new Set(['pty-1', 'pty-2']),
      new Set(['pty-2']),
      new Set(['pty-1'])
    )

    expect(result.changed).toBe(true)
    expect([...result.enabledHandles]).toEqual(['pty-2'])
    expect([...result.defaultedHandles]).toEqual(['pty-2', 'pty-1'])
  })

  it('prunes terminal handles that disappear from session snapshots', () => {
    const result = pruneTerminalLiveInputHandles(
      new Set(['pty-1', 'pty-stale']),
      new Set(['pty-1', 'pty-2', 'pty-stale']),
      new Set(['pty-1', 'pty-2'])
    )

    expect(result.changed).toBe(true)
    expect([...result.enabledHandles]).toEqual(['pty-1'])
    expect([...result.defaultedHandles]).toEqual(['pty-1', 'pty-2'])
  })

  it('does not allocate pruned live input sets when every tracked handle is live', () => {
    const enabled = new Set(['pty-1'])
    const defaulted = new Set(['pty-1'])
    const result = pruneTerminalLiveInputHandles(enabled, defaulted, new Set(['pty-1', 'pty-2']))

    expect(result.changed).toBe(false)
    expect(result.enabledHandles).toBe(enabled)
    expect(result.defaultedHandles).toBe(defaulted)
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
})
