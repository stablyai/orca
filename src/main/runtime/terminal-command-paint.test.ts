import { describe, expect, it } from 'vitest'
import {
  hasTerminalCommandPainted,
  observeTerminalCommandPaint,
  type TerminalCommandPaintRecord
} from './terminal-command-paint'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'

function observe(record: TerminalCommandPaintRecord, data: string): void {
  observeTerminalCommandPaint(record, data, normalizeTerminalChunk(data).text)
}

describe('terminal command paint', () => {
  it('reads a pane with no command-start marker as painted', () => {
    const record: TerminalCommandPaintRecord = {}
    observe(record, '~/repo % ')
    expect(hasTerminalCommandPainted(record)).toBe(true)
  })

  it('does not count the prompt, the echoed command, or a title set after the marker', () => {
    const record: TerminalCommandPaintRecord = {}
    observe(record, '\x1b]133;A\x07~/repo % amp\r\n\x1b]133;C\x07\x1b]0;amp\x07')
    expect(hasTerminalCommandPainted(record)).toBe(false)
    observe(record, '\x1b[?1049h\x1b[?25l\r\n')
    expect(hasTerminalCommandPainted(record)).toBe(false)
    observe(record, '\x1b[2;3H╭─ Amp')
    expect(hasTerminalCommandPainted(record)).toBe(true)
  })

  it('counts a paint that arrives in the same chunk as the marker', () => {
    const record: TerminalCommandPaintRecord = {}
    observe(record, '\x1b]133;C\x1b\\\x1b[?1049hLIVE-TUI')
    expect(hasTerminalCommandPainted(record)).toBe(true)
  })

  it('finds a marker split across chunks, and counts only output after it', () => {
    const record: TerminalCommandPaintRecord = {}
    observe(record, '~/repo % amp\r\n\x1b]13')
    observe(record, '3;C\x07')
    expect(hasTerminalCommandPainted(record)).toBe(false)
    observe(record, '\x1b]133;C;cmdline_url=')
    observe(record, 'amp\x07╭─ Amp')
    expect(hasTerminalCommandPainted(record)).toBe(true)
  })

  it('starts over at the next command', () => {
    const record: TerminalCommandPaintRecord = {}
    observe(record, '\x1b]133;C\x07goose> ')
    observe(record, '\x1b]133;D;0\x07\x1b]133;A\x07% goose\r\n\x1b]133;C\x07')
    expect(hasTerminalCommandPainted(record)).toBe(false)
  })
})
