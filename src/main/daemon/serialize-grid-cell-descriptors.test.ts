import { describe, expect, it } from 'vitest'
import { compareBufferRows } from './serialize-grid-cell-descriptors'
import { createFuzzTerminal, writeTerminal } from './serialize-grid-roundtrip'

describe('serialize grid comparison policy', () => {
  it.each([
    ['abc界', 'abc ', 4, false],
    ['abc界', 'abc\x1b[48;2;1;2;3m ', 4, false],
    ['abc ', 'abc界', 4, true],
    ['é', 'è', 8, true],
    ['\x1b[32mA', '\x1b[38;5;2mA', 8, false],
    ['\x1b[42m ', '\x1b[48;5;2m ', 8, false],
    ['\x1b[7;31m ', '\x1b[7;32m ', 8, true],
    ['\x1b[4m\x1b[2J', '\x1b[2J', 8, false],
    ['\x1b[4m ', ' ', 8, true],
    ['\x1b[4m \x1b[0mB', ' B', 8, true],
    ['text\r\n', 'text', 8, false],
    ['text\r\n\x1b[48;2;1;2;3m\x1b[2K', 'text', 8, true]
  ] as const)(
    'preserves blank, clipped and color policy for %j / %j',
    (expected, actual, cols, differs) => {
      const source = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 10 })
      const replay = createFuzzTerminal({ cols: 8, rows: 4, scrollback: 10 })
      try {
        writeTerminal(source, expected)
        writeTerminal(replay, actual)
        expect(
          Boolean(
            compareBufferRows(
              'policy',
              source.buffer.active,
              0,
              source.buffer.active.length,
              replay.buffer.active,
              0,
              replay.buffer.active.length,
              cols
            )
          )
        ).toBe(differs)
      } finally {
        source.dispose()
        replay.dispose()
      }
    }
  )
})
