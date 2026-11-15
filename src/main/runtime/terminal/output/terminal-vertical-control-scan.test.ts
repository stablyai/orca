import { describe, expect, it } from 'vitest'
import {
  containsTerminalVerticalLineControl,
  normalizeTerminalChunk
} from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './tail/terminal-tail-buffer'

describe('terminal vertical-control scanning', () => {
  it('preserves printable spans and carried controls across chunk boundaries', () => {
    const first = normalizeTerminalChunk('漢\ud800\x1b[31m字\t\r\n\x00a\x1b[2')
    expect(first).toEqual({ text: '漢\ud800字\t\na', pendingAnsi: '\x1b[2' })
    expect(normalizeTerminalChunk('K\udfff😀\b\r\x7f\x9fend', first.pendingAnsi)).toEqual({
      text: '\x1b[2K\udfff😀\b\rend',
      pendingAnsi: ''
    })
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
