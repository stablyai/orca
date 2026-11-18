import { describe, expect, it } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  hasTerminalAgentPainted,
  observeTerminalCommandPaint,
  isCurrentCommandReport,
  takeReattachedRepaintRequest,
  vouchTerminalSpawn,
  type TerminalCommandPaintRecord
} from './terminal-command-paint'

const FINISH_MARKER = '\x1b]133;D;0\x07'

describe('terminal command paint after a reattach', () => {
  it('waits for the reattached program to paint something visible', () => {
    const record: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(record, 1_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(false)
    expect(hasTerminalAgentPainted(record, 'claude')).toBe(false)

    observeTerminalCommandPaint(record, '\x1b[?2004h', '\x1b[?2004h', 2_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(false)

    observeTerminalCommandPaint(record, '❯ Ask me anything…', '❯ Ask me anything…', 2_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
    expect(hasTerminalAgentPainted(record, 'claude')).toBe(true)
  })

  it('allows one repaint request per reattach, and none once the program painted', () => {
    const quiet: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(quiet, 1_000)
    expect(takeReattachedRepaintRequest(quiet)).toBe(true)
    expect(takeReattachedRepaintRequest(quiet)).toBe(false)

    const painted: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(painted, 1_000)
    observeTerminalCommandPaint(painted, 'ready', 'ready', 2_000)
    expect(takeReattachedRepaintRequest(painted)).toBe(false)
  })

  it('never fences a process this run saw start, however often it is reattached', () => {
    const record: TerminalCommandPaintRecord = {}
    vouchTerminalSpawn(record)
    observeTerminalCommandPaint(record, 'ready', 'ready', 2_000)
    awaitReattachedTerminalPaint(record, 3_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
    expect(isCurrentCommandReport(record, null)).toBe(true)
    expect(takeReattachedRepaintRequest(record)).toBe(false)
  })

  it('stops holding a finished reattached command once output was lost', () => {
    const record: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(record, 1_000)
    observeTerminalCommandPaint(record, FINISH_MARKER, FINISH_MARKER, 2_000)
    record.commandPaint?.noteGap()
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
  })

  it('remembers a process this run saw start across lost output', () => {
    const record: TerminalCommandPaintRecord = {}
    vouchTerminalSpawn(record)
    record.commandPaint?.noteGap()
    awaitReattachedTerminalPaint(record, 3_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
  })
})

describe('the command an agent report speaks for', () => {
  const START = '\x1b]133;C\x07'
  const FINISH = '\x1b]133;D;0\x07'

  it('retires reports when the command finishes, even in the chunk that started it', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, `${START}ok\r\n${FINISH}`, `${START}ok\r\n${FINISH}`, 1_000)
    expect(isCurrentCommandReport(record, 1_000)).toBe(false)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(false)
  })

  it('retires reports at a finish whose start it never saw', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, FINISH, FINISH, 1_000)
    expect(isCurrentCommandReport(record, 900)).toBe(false)
  })

  it('counts a report stamped in the same read as the start, and keeps the start across the agent own markers', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, START, START, 1_000)
    expect(isCurrentCommandReport(record, 1_000)).toBe(true)
    expect(isCurrentCommandReport(record, 999)).toBe(false)
    observeTerminalCommandPaint(record, START, START, 5_000)
    expect(isCurrentCommandReport(record, 2_000)).toBe(true)
  })

  it('starts the next command at a start that follows a finish in the same read', () => {
    const record: TerminalCommandPaintRecord = {}
    observeTerminalCommandPaint(record, START, START, 1_000)
    const handoff = `${FINISH}~/repo % codex\r\n${START}`
    observeTerminalCommandPaint(record, handoff, handoff, 5_000)
    // A report stamped while that read was handled may precede its finish.
    expect(isCurrentCommandReport(record, 2_000)).toBe(false)
    expect(isCurrentCommandReport(record, 5_004)).toBe(false)
    observeTerminalCommandPaint(record, 'Python 3', 'Python 3', 6_000)
    expect(isCurrentCommandReport(record, 5_004)).toBe(false)
    expect(isCurrentCommandReport(record, 6_000)).toBe(true)
  })
})
