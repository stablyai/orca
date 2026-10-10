import { describe, expect, it, vi } from 'vitest'
import * as ownership from '../../shared/own-retained-string'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { MAX_TAIL_PENDING_ANSI_CHARS } from './terminal-tail-limits'

const INCOMPLETE_STATUS = '\x1b]9999;{"state":"working","prompt":"fragment'

describe('terminal preview pending ANSI storage', () => {
  it('routes every retained pending control through ownRetainedString', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const first = normalizeTerminalChunk('x'.repeat(32 * 1024) + INCOMPLETE_STATUS)
      expect(own).toHaveBeenCalledTimes(1)
      expect(own).toHaveBeenLastCalledWith(INCOMPLETE_STATUS)
      expect(first.pendingAnsi).toBe(INCOMPLETE_STATUS)

      // Ownership is unconditional: a growing fragment is re-owned on every chunk.
      let pending = first.pendingAnsi
      for (let index = 0; index < 8; index += 1) {
        pending = normalizeTerminalChunk('x'.repeat(512), pending).pendingAnsi
      }
      expect(own).toHaveBeenCalledTimes(9)
      expect(own).toHaveBeenLastCalledWith(pending)
    } finally {
      own.mockRestore()
    }
  })

  it.each([
    [16 * 1024, 256, INCOMPLETE_STATUS],
    [64 * 1024, 64, INCOMPLETE_STATUS],
    [1024 * 1024, 16, INCOMPLETE_STATUS],
    [16 * 1024, 128, INCOMPLETE_STATUS + 'x'.repeat(16 * 1024)]
  ])('keeps %i-character chunks with %i incomplete statuses byte-exact', (size, count, control) => {
    const tails: string[] = []
    let cleanChars = 0
    for (let index = 0; index < count; index++) {
      const result = normalizeTerminalChunk(
        String.fromCharCode(65 + (index % 26)).repeat(size) + control
      )
      cleanChars += result.text.length
      tails.push(result.pendingAnsi)
    }

    expect(cleanChars).toBe(size * count)
    const expected =
      control.length <= MAX_TAIL_PENDING_ANSI_CHARS
        ? control
        : control.slice(0, 2) + control.slice(-(MAX_TAIL_PENDING_ANSI_CHARS - 2))
    for (const pending of tails) {
      expect(pending).toBe(expected)
      expect(normalizeTerminalChunk('"}\x07after', pending)).toEqual({
        text: 'after',
        pendingAnsi: ''
      })
    }
  })

  it.each(['\x1b]', '\x1bP', '\x1b['])('preserves trimming and code units for %j', (prefix) => {
    for (const length of [4095, 4096, 4097, 16 * 1024]) {
      const value = `${prefix}${'x'.repeat(length - 7)}漢\ud8001\udc00\ud83d`
      const expected =
        value.length <= MAX_TAIL_PENDING_ANSI_CHARS
          ? value
          : prefix + value.slice(-(MAX_TAIL_PENDING_ANSI_CHARS - prefix.length))
      // CSI parameters must stay below its final-byte range until the suffix is retained.
      const input = prefix === '\x1b[' ? value.replaceAll('x', '1') : value
      const expectedInput = prefix === '\x1b[' ? expected.replaceAll('x', '1') : expected
      const result = normalizeTerminalChunk('a'.repeat(32 * 1024) + input)
      expect(result).toEqual({
        text: 'a'.repeat(32 * 1024),
        pendingAnsi: expectedInput
      })
    }
  })

  it.each(['\x07', '\x1b\\'])('preserves split UTF-16 through %j termination', (terminator) => {
    const pending = '\x1b]2;漢\ud800|\udc00|\ud83d'
    const first = normalizeTerminalChunk('x'.repeat(16 * 1024) + pending)
    expect(first.pendingAnsi).toBe(pending)
    expect(normalizeTerminalChunk(`\ude00${terminator}after`, first.pendingAnsi)).toEqual({
      text: 'after',
      pendingAnsi: ''
    })
  })

  it('keeps trimming an owned fragment that grows past the cap', () => {
    let pending = '\x1b]2;'
    for (let index = 0; index < 128; index++) {
      pending = normalizeTerminalChunk('x'.repeat(512), pending).pendingAnsi
    }
    expect(pending).toBe(`\x1b]${'x'.repeat(MAX_TAIL_PENDING_ANSI_CHARS - 2)}`)
    expect(normalizeTerminalChunk('\x07after', pending)).toEqual({
      text: 'after',
      pendingAnsi: ''
    })
  })
})
