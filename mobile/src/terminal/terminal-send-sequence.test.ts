import { describe, expect, it } from 'vitest'
import {
  createTerminalSendSequenceState,
  nextTerminalSendSequence,
  noteTerminalSendRoundTrip,
  restartTerminalSendStream,
  setHostOrdersTerminalSends,
  TERMINAL_SEND_WINDOW,
  terminalSendSpacingMs,
  terminalSendWindow
} from './terminal-send-sequence'

function orderedHostState() {
  const state = createTerminalSendSequenceState()
  setHostOrdersTerminalSends(state, true)
  return state
}

describe('terminal send sequence', () => {
  it('keeps one send outstanding and numbers nothing until the host says it orders sends', () => {
    const state = createTerminalSendSequenceState()

    expect(terminalSendWindow(state)).toBe(1)
    expect(nextTerminalSendSequence(state, 'keys', 'terminal-1')).toBeUndefined()
  })

  it('opens the window and numbers sends from one for a host that orders them', () => {
    const state = orderedHostState()

    expect(terminalSendWindow(state)).toBe(TERMINAL_SEND_WINDOW)
    const first = nextTerminalSendSequence(state, 'keys', 'terminal-1')
    const second = nextTerminalSendSequence(state, 'keys', 'terminal-1')
    expect(first?.seq).toBe(1)
    expect(second).toEqual({ stream: first?.stream, seq: 2 })
  })

  it('numbers each lane and each terminal in its own stream', () => {
    const state = orderedHostState()

    const keys = nextTerminalSendSequence(state, 'keys', 'terminal-1')
    const gestures = nextTerminalSendSequence(state, 'gestures', 'terminal-1')
    const otherTerminal = nextTerminalSendSequence(state, 'keys', 'terminal-2')

    expect([keys?.seq, gestures?.seq, otherTerminal?.seq]).toEqual([1, 1, 1])
    expect(new Set([keys?.stream, gestures?.stream, otherTerminal?.stream]).size).toBe(3)
  })

  it('starts a new stream after a send whose delivery is unknown', () => {
    const state = orderedHostState()
    const before = nextTerminalSendSequence(state, 'keys', 'terminal-1')

    restartTerminalSendStream(state, 'keys', 'terminal-1')
    const after = nextTerminalSendSequence(state, 'keys', 'terminal-1')

    expect(after?.seq).toBe(1)
    expect(after?.stream).not.toBe(before?.stream)
  })

  it('spaces sends one window per measured round trip, and not at all before a reply', () => {
    const state = orderedHostState()
    expect(terminalSendSpacingMs(state)).toBe(0)

    noteTerminalSendRoundTrip(state, 800)

    expect(terminalSendSpacingMs(state)).toBe(800 / TERMINAL_SEND_WINDOW)
  })

  it('does not let one stalled reply slow every later send', () => {
    const state = orderedHostState()
    noteTerminalSendRoundTrip(state, 80)

    noteTerminalSendRoundTrip(state, 30_000)

    expect(terminalSendSpacingMs(state)).toBeLessThan(1_000 / TERMINAL_SEND_WINDOW)
  })

  it('does not space sends to a host that takes one at a time', () => {
    const state = createTerminalSendSequenceState()
    noteTerminalSendRoundTrip(state, 800)

    expect(terminalSendSpacingMs(state)).toBe(0)
  })

  it('forgets its streams when the host changes', () => {
    const state = orderedHostState()
    const before = nextTerminalSendSequence(state, 'keys', 'terminal-1')

    setHostOrdersTerminalSends(state, true)
    const after = nextTerminalSendSequence(state, 'keys', 'terminal-1')

    expect(after?.seq).toBe(1)
    expect(after?.stream).not.toBe(before?.stream)
  })
})
