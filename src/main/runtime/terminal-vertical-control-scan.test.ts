import { describe, expect, it, vi } from 'vitest'
import {
  containsTerminalVerticalLineControl,
  normalizeTerminalChunk
} from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

describe('terminal vertical-control scanning', () => {
  it.each([
    ['plain', 'log output '.repeat(8192), false],
    ['nonvertical CSI', `\x1b[31m${'log output '.repeat(8192)}\x1b[0m`, false],
    ['vertical CSI', `${'漢字😀 output '.repeat(8192)}\x1b[2A`, true]
  ] as const)('bounds code-unit inspections on %s output', (_name, input, expected) => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    let actual: boolean
    let inspections: number
    try {
      actual = containsTerminalVerticalLineControl(input)
      inspections = charCodeAt.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
    }

    expect(actual).toBe(expected)
    expect(inspections).toBeLessThan(16)
  })

  it.each([
    ['\x1b[A', true],
    ['\x1b[0A', true],
    ['\x1b[;A', true],
    ['\x1b[12;34A', true],
    ['\x1b[?1A', false],
    ['\x1b[1:2A', false],
    ['\x1b[1 A', false],
    ['\x1b[1\nA', false],
    ['\x1b[1B', false],
    ['\x9b1A', false],
    ['\x1b', false],
    ['\x1b[123', false]
  ] as const)('preserves numeric CSI A recognition for %j', (input, expected) => {
    expect(containsTerminalVerticalLineControl(input)).toBe(expected)
  })

  it.each([
    ['OSC BEL', '\x1b]2;title', '\x07'],
    ['OSC ST', '\x1b]2;title', '\x1b\\'],
    ['DCS', '\x1bPpayload', '\x1b\\'],
    ['SOS', '\x1bXpayload', '\x1b\\'],
    ['PM', '\x1b^payload', '\x1b\\'],
    ['APC', '\x1b_payload', '\x1b\\']
  ])('skips embedded CSI and stops at an incomplete %s', (_name, prefix, terminator) => {
    const incomplete = `${prefix}\x1b[2A`
    expect(containsTerminalVerticalLineControl(incomplete)).toBe(false)
    expect(containsTerminalVerticalLineControl(`${incomplete}${terminator}ordinary`)).toBe(false)
    expect(containsTerminalVerticalLineControl(`${incomplete}${terminator}\x1b[3A`)).toBe(true)
  })

  it.each([
    // An ESC inside CSI parameter bytes is consumed by that control, not treated as a new introducer.
    ['\x1b[\x1b[A', false],
    ['\x1b[\x1b[2A\x1b[1A', true],
    ['\x1b[31m\x1b[1A', true],
    ['\x1b]0;t\x07\x1b[1A', true],
    ['\x1b[1A\x1b', true],
    ['ordinary\x1b', false],
    ['ordinary\x1b[0m more\x1b[1;A', true]
  ] as const)('resumes scanning after a parsed control for %j', (input, expected) => {
    expect(containsTerminalVerticalLineControl(input)).toBe(expected)
  })

  it('preserves tail rows when ordinary output is followed by a cursor-up redraw', () => {
    const first = appendNormalizedToTailBuffer([], '', 'first\nold\n')
    const normalized = normalizeTerminalChunk('\x1b[1A\x1b[2K\x1b[32mnew\x1b[0m\n')
    const next = appendNormalizedToTailBuffer(
      first.lines,
      first.partialLine,
      normalized.text,
      first.redrawCursor
    )

    expect(next.lines).toEqual(['first', 'new'])
    expect(next.partialLine).toBe('')
  })
})
