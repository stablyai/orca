import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import {
  DEFAULT_TERMINAL_HISTORY_TAIL_LINES,
  buildTerminalHistory,
  terminalHistoryTailLines
} from './terminal-history-text'
import { MAX_TERMINAL_READ_LIMIT } from './terminal-tail-limits'

function read(overrides: Partial<RuntimeTerminalRead> = {}): RuntimeTerminalRead {
  return {
    handle: 'term_abc',
    status: 'running',
    tail: ['Traceback (most recent call last):', '  File "app.py", line 3', 'ZeroDivisionError'],
    truncated: false,
    nextCursor: '3',
    ...overrides
  }
}

describe('terminalHistoryTailLines', () => {
  it('defaults when the caller names no tail', () => {
    expect(terminalHistoryTailLines(undefined)).toBe(DEFAULT_TERMINAL_HISTORY_TAIL_LINES)
  })

  it('falls back to the default rather than trusting a nonsense tail', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(terminalHistoryTailLines(value), String(value)).toBe(
        DEFAULT_TERMINAL_HISTORY_TAIL_LINES
      )
    }
  })

  it('honors an explicit tail and clamps it to what the host retains', () => {
    expect(terminalHistoryTailLines(500)).toBe(500)
    expect(terminalHistoryTailLines(MAX_TERMINAL_READ_LIMIT + 1)).toBe(MAX_TERMINAL_READ_LIMIT)
  })
})

describe('buildTerminalHistory', () => {
  it('joins the retained tail into one string an agent can paste', () => {
    expect(buildTerminalHistory(read())).toEqual({
      handle: 'term_abc',
      status: 'running',
      history: 'Traceback (most recent call last):\n  File "app.py", line 3\nZeroDivisionError',
      lineCount: 3,
      truncated: false
    })
  })

  it('reports a capped read as truncated so the agent knows it lacks the top of the trace', () => {
    expect(buildTerminalHistory(read({ limited: true })).truncated).toBe(true)
    expect(buildTerminalHistory(read({ truncated: true })).truncated).toBe(true)
  })

  it('carries the read source through and omits it when the host did not label one', () => {
    expect(buildTerminalHistory(read({ source: 'screen' })).source).toBe('screen')
    expect('source' in buildTerminalHistory(read())).toBe(false)
  })

  it('keeps an empty buffer an empty string rather than a blank line', () => {
    expect(buildTerminalHistory(read({ tail: [] }))).toMatchObject({ history: '', lineCount: 0 })
  })
})
