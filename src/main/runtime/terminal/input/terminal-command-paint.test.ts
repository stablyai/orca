import { describe, expect, it } from 'vitest'
import {
  awaitReattachedTerminalPaint,
  hasTerminalAgentPainted,
  observeTerminalCommandPaint,
  isCurrentCommandReport,
  isCurrentCommandStatus,
  isShellInFront,
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
    const request = quiet.commandPaint!
    expect(request.beginReattachedRepaintRequest()).toBe(true)
    // One request at a time, and once a host asked the program, none again.
    expect(request.beginReattachedRepaintRequest()).toBe(false)
    request.settleReattachedRepaintRequest('nudged')
    expect(request.beginReattachedRepaintRequest()).toBe(false)

    // A phone driving the grid repaints through its own layout: no request again, and no alert.
    const phone: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(phone, 1_000)
    phone.commandPaint?.beginReattachedRepaintRequest()
    phone.commandPaint?.settleReattachedRepaintRequest('not-sent')
    expect(phone.commandPaint?.beginReattachedRepaintRequest()).toBe(false)
    expect(phone.commandPaint?.awaitsPaintNoHostCanRequest()).toBe(false)

    // A host that cannot repaint is not asked again for this reattach.
    const conpty: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(conpty, 1_000)
    conpty.commandPaint?.beginReattachedRepaintRequest()
    conpty.commandPaint?.settleReattachedRepaintRequest('unavailable')
    expect(conpty.commandPaint?.beginReattachedRepaintRequest()).toBe(false)
    expect(conpty.commandPaint?.awaitsPaintNoHostCanRequest()).toBe(true)

    // Output lost while a request is out re-arms it: the answer must not spend the new one.
    const gap: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(gap, 1_000)
    gap.commandPaint?.beginReattachedRepaintRequest()
    gap.commandPaint?.noteGap()
    gap.commandPaint?.settleReattachedRepaintRequest('nudged')
    expect(gap.commandPaint?.beginReattachedRepaintRequest()).toBe(true)

    const painted: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(painted, 1_000)
    observeTerminalCommandPaint(painted, 'ready', 'ready', 2_000)
    expect(painted.commandPaint?.beginReattachedRepaintRequest()).toBe(false)
  })

  it('remembers a locally started process across reattach and lost output', () => {
    const record: TerminalCommandPaintRecord = {}
    vouchTerminalSpawn(record)
    observeTerminalCommandPaint(record, 'ready', 'ready', 2_000)
    awaitReattachedTerminalPaint(record, 3_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
    expect(isCurrentCommandReport(record, null)).toBe(true)
    expect(record.commandPaint?.beginReattachedRepaintRequest()).toBe(false)

    record.commandPaint?.noteGap()
    awaitReattachedTerminalPaint(record, 4_000)
    expect(hasTerminalAgentPainted(record, 'hermes')).toBe(true)
  })

  it('stops holding a finished reattached command once output was lost', () => {
    const record: TerminalCommandPaintRecord = {}
    awaitReattachedTerminalPaint(record, 1_000)
    observeTerminalCommandPaint(record, FINISH_MARKER, FINISH_MARKER, 2_000)
    record.commandPaint?.noteGap()
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
    expect(isShellInFront(record)).toBe(true)
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
    expect(isCurrentCommandReport(record, 2_000)).toBe(false)
    // The exiting agent's rest title in that read is stamped after it, in the next read's millisecond.
    Object.assign(record, { lastOscTitleAt: 7, lastOscTitleEpochMs: 6_000 })
    observeTerminalCommandPaint(record, 'Python 3', 'Python 3', 6_000)
    expect(isCurrentCommandStatus(record, 6_000)).toBe(false)
    Object.assign(record, { lastOscTitleAt: 8 })
    expect(isCurrentCommandStatus(record, 6_000)).toBe(true)
  })

  it("keeps a finished agent's title retired across lost output, while a newer title counts", () => {
    const record: TerminalCommandPaintRecord = { lastOscTitleAt: 3 }
    awaitReattachedTerminalPaint(record, 1_000)
    observeTerminalCommandPaint(record, FINISH, FINISH, 2_000)
    record.commandPaint?.noteGap()
    expect(isCurrentCommandStatus(record, 500)).toBe(false)
    Object.assign(record, { lastOscTitleAt: 4 })
    expect(isCurrentCommandStatus(record, 3_000)).toBe(true)
  })

  it("retires the last command's title at a start in its own read, even in the same millisecond", () => {
    const record: TerminalCommandPaintRecord = { lastOscTitleAt: 3 }
    observeTerminalCommandPaint(record, START, START, 1_000)
    expect(isCurrentCommandStatus(record, 1_000)).toBe(false)
    Object.assign(record, { lastOscTitleAt: 4 })
    expect(isCurrentCommandStatus(record, 1_000)).toBe(true)
  })
})
