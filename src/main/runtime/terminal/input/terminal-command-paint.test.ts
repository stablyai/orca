import { describe, expect, it } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  hasTerminalAgentPainted,
  observeTerminalCommandPaint,
  takeReattachedRepaintRequest,
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

  it('allows one repaint request per reattach, and none once the program painted', () => {
    const quiet: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(quiet)
    expect(takeReattachedRepaintRequest(quiet)).toBe(true)
    expect(takeReattachedRepaintRequest(quiet)).toBe(false)

    const painted: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(painted)
    observeTerminalCommandPaint(painted, 'ready', 'ready')
    expect(takeReattachedRepaintRequest(painted)).toBe(false)
  })
})
