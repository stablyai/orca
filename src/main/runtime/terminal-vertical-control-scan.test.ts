import { describe, expect, it } from 'vitest'
import {
  containsTerminalVerticalLineControl,
  normalizeTerminalChunk
} from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

describe('terminal vertical-control scanning', () => {
  it('keeps a line control with long retained CSI parameters', () => {
    const input = `\x1b[${'1;'.repeat(2048)}A`
    expect(normalizeTerminalChunk(input)).toEqual({
      text: input,
      pendingAnsi: ''
    })
  })

  it('retains exactly the preview line-control CSI finals', () => {
    const retained: string[] = []
    for (let code = 0x40; code <= 0x7e; code += 1) {
      const final = String.fromCharCode(code)
      for (const params of ['', '2']) {
        const control = `\x1b[${params}${final}`
        const { text } = normalizeTerminalChunk(`a${control}b`)
        if (text === `a${control}b`) {
          retained.push(control)
        } else {
          expect(text).toBe('ab')
        }
      }
    }
    expect(retained).toEqual([
      '\x1b[A',
      '\x1b[2A',
      '\x1b[C',
      '\x1b[2C',
      '\x1b[D',
      '\x1b[2D',
      '\x1b[G',
      '\x1b[2G',
      '\x1b[K',
      '\x1b[2K',
      '\x1b[`',
      '\x1b[2`'
    ])
  })

  it('preserves printable spans and carried controls across chunk boundaries', () => {
    const first = normalizeTerminalChunk('漢\ud800\x1b[31m字\t\r\n\x00a\x1b[2')
    expect(first).toEqual({ text: '漢\ud800字\t\na', pendingAnsi: '\x1b[2' })
    expect(normalizeTerminalChunk('K\udfff😀\b\r\x7f\x9fend', first.pendingAnsi)).toEqual({
      text: '\x1b[2K\udfff😀\b\rend',
      pendingAnsi: ''
    })
  })

  it.each([
    ['plain', 'log output '.repeat(8192), false],
    ['nonvertical CSI', `\x1b[31m${'log output '.repeat(8192)}\x1b[0m`, false],
    ['vertical CSI', `${'漢字😀 output '.repeat(8192)}\x1b[2A`, true]
  ] as const)('detects vertical controls in %s output', (_name, input, expected) => {
    expect(containsTerminalVerticalLineControl(input)).toBe(expected)
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
