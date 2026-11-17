import { describe, expect, it } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  hasTerminalAgentPainted,
  observeTerminalCommandPaint,
  type TerminalCommandPaintRecord
} from './terminal-command-paint'

describe('terminal command paint after a reattach', () => {
  it('waits for the reattached program to paint something visible', () => {
    const record: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(record)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(false)
    expect(hasTerminalAgentPainted(record, 'claude')).toBe(false)

    observeTerminalCommandPaint(record, '\x1b[?2004h', '\x1b[?2004h')
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(false)

    observeTerminalCommandPaint(record, '❯ Ask me anything…', '❯ Ask me anything…')
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
    expect(hasTerminalAgentPainted(record, 'claude')).toBe(true)
  })
})
