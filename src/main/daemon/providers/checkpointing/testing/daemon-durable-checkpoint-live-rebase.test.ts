import { afterEach, describe, expect, it } from 'vitest'
import { boundSnapshot, buildDurableCheckpointSnapshot } from '../daemon-durable-history-snapshot'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT as DAEMON_RESTORE_SCROLLBACK_ROWS } from '../../../../../shared/terminal/replay/terminal-scrollback-policy'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../../../sessions/daemon-session-scrollback-window'
import { HeadlessEmulator } from '../../../emulation/headless-emulator'
import { getRecoveredHistorySeedSegments } from '../../../history/seed-transfer/terminal-history-seed-segments'
import type { ColdRestoreInfo } from '../../../history/restoration/terminal-history-cold-restore-info'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'

const DEAD_TUI_MODES = ['\x1b[?1049h', '\x1b[?1003h', '\x1b[?1006h']
const emulators: HeadlessEmulator[] = []

afterEach(() => {
  for (const emulator of emulators.splice(0)) {
    emulator.dispose()
  }
})

function emulator(opts: { scrollback: number; cols?: number; rows?: number }): HeadlessEmulator {
  const created = new HeadlessEmulator({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    scrollback: opts.scrollback
  })
  emulators.push(created)
  return created
}

function write(target: HeadlessEmulator, data: string): void {
  expect(target.writeSync(data)).toBe(true)
}

function numberedLines(from: number, to: number, prefix = 'LINE'): string {
  let output = ''
  for (let index = from; index <= to; index += 1) {
    output += `${prefix}_${String(index).padStart(5, '0')}\r\n`
  }
  return output
}

function restoreInfoFrom(snapshot: TerminalSnapshot): ColdRestoreInfo {
  return { ...snapshot, cwd: snapshot.cwd ?? '/tmp' }
}

function replayedRows(snapshot: TerminalSnapshot): string[] {
  const target = emulator({
    scrollback: 20_000,
    cols: snapshot.cols,
    rows: snapshot.rows
  })
  write(target, snapshot.scrollbackAnsi)
  write(target, snapshot.rehydrateSequences)
  write(target, snapshot.snapshotAnsi)
  if (snapshot.modes.alternateScreen) {
    write(target, '\x1b[?1049l')
  }
  return target.getBufferTailLines(Number.MAX_SAFE_INTEGER)
}

function numberedRowIds(rows: string[], prefix = 'LINE'): number[] {
  return rows.flatMap((row) => {
    const match = new RegExp(`^${prefix}_(\\d{5})$`).exec(row.trimEnd())
    return match ? [Number(match[1])] : []
  })
}

function expectConsecutive(ids: number[], first: number, last: number): void {
  expect(ids[0]).toBe(first)
  expect(ids.at(-1)).toBe(last)
  expect(ids).toHaveLength(last - first + 1)
  expect(ids.every((id, index) => id === first + index)).toBe(true)
}

function poisonedColdRestore(): {
  restoreInfo: ColdRestoreInfo
  live: HeadlessEmulator
} {
  const dead = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
  write(dead, numberedLines(1, 40, 'OLD'))
  write(dead, '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[HDEAD_TUI_FRAME')
  const restoreInfo = restoreInfoFrom(dead.getSnapshot())
  expect(restoreInfo.modes.alternateScreen).toBe(true)
  expect(restoreInfo.modes.mouseTracking).toBe(true)

  const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
  for (const segment of getRecoveredHistorySeedSegments(restoreInfo)) {
    write(live, segment)
  }
  return { restoreInfo, live }
}

function expectNoDeadTuiModes(snapshot: TerminalSnapshot): void {
  expect(snapshot.modes.alternateScreen).toBe(false)
  expect(snapshot.modes.mouseTracking).toBe(false)
  for (const sequence of DEAD_TUI_MODES) {
    expect(snapshot.rehydrateSequences).not.toContain(sequence)
    expect(snapshot.snapshotAnsi).not.toContain(sequence)
  }
  expect(snapshot.frameRestoreAnsi).toBeUndefined()
}

describe('durable checkpoint rebased on the live snapshot', () => {
  it('drops a dead TUI alt screen and mouse modes after one compaction', async () => {
    const { restoreInfo, live } = poisonedColdRestore()
    const newOutput = 'new shell prompt $ '
    write(live, newOutput)
    const liveSnapshot = { ...live.getSnapshot(), outputSequence: 11 }
    expect(liveSnapshot.modes.mouseTracking).toBe(false)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [{ kind: 'output', data: newOutput }],
      isFirstTake: false
    })

    expectNoDeadTuiModes(durable)
    expect(durable.outputSequence).toBe(11)
    const rows = replayedRows(durable)
    expect(numberedRowIds(rows, 'OLD')).toHaveLength(40)
    expect(rows.join('\n')).toContain(newOutput.trimEnd())
  })

  it('serves live modes for a boundary fold with zero pending records', async () => {
    const { restoreInfo, live } = poisonedColdRestore()
    const liveSnapshot = { ...live.getSnapshot(), outputSequence: 3 }

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [],
      isFirstTake: false
    })

    expectNoDeadTuiModes(durable)
    expect(durable.outputSequence).toBe(3)
    expect(numberedRowIds(replayedRows(durable), 'OLD')).toHaveLength(40)
  })

  it('keeps the live alt frame, modes and owner verbatim', async () => {
    const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
    write(disk, numberedLines(1, 2_000))
    const restoreInfo = restoreInfoFrom(disk.getSnapshot())

    const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
    const tui = '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[HLIVE_TUI_FRAME'
    write(live, numberedLines(1, 2_000))
    write(live, tui)
    const liveSnapshot: TerminalSnapshot = {
      ...live.getSnapshot(),
      terminalOwner: 'shell',
      outputSequence: 5
    }

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [{ kind: 'output', data: tui }],
      isFirstTake: false
    })

    expect(durable.snapshotAnsi).toBe(liveSnapshot.snapshotAnsi)
    expect(durable.rehydrateSequences).toBe(liveSnapshot.rehydrateSequences)
    expect(durable.frameRestoreAnsi).toBe(liveSnapshot.frameRestoreAnsi)
    expect(durable.modes).toEqual(liveSnapshot.modes)
    expect(durable.terminalOwner).toBe('shell')
    expect(durable.scrollbackAnsi.endsWith(liveSnapshot.scrollbackAnsi)).toBe(true)
    expectConsecutive(numberedRowIds(replayedRows(durable)), 1, 2_000)
  })

  it('keeps restore depth with rows the live window evicted, without seam duplicates', async () => {
    const baseLines = numberedLines(1, 6_000)
    const newLines = numberedLines(6_001, 6_200)
    const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
    write(disk, baseLines)
    const restoreInfo = restoreInfoFrom(disk.getSnapshot())
    const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
    write(live, baseLines + newLines)
    const liveSnapshot = live.getSnapshot()
    expect(liveSnapshot.scrollbackLines).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [{ kind: 'output', data: newLines }],
      isFirstTake: false
    })

    expect(durable.scrollbackLines).toBe(DAEMON_RESTORE_SCROLLBACK_ROWS)
    // 5000 scrollback + 24 screen rows, the last of which is the blank cursor row.
    const newest = 6_200
    const oldest = newest - (DAEMON_RESTORE_SCROLLBACK_ROWS + 24 - 2)
    expectConsecutive(numberedRowIds(replayedRows(durable)), oldest, newest)
  })

  it('bounds a folded checkpoint to the rows a small-depth rebase of live would keep', async () => {
    const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
    write(disk, numberedLines(1, 3_700))
    const restoreInfo = restoreInfoFrom(disk.getSnapshot())
    const pending = `${numberedLines(3_701, 4_000)}\x1b[=1;1u`
    const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
    write(live, numberedLines(1, 3_700) + pending)
    const liveSnapshot: TerminalSnapshot = { ...live.getSnapshot(), outputSequence: 6 }
    expect(liveSnapshot.modes.kittyKeyboardFlags).toBe(1)
    const committed = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo,
      pendingRecords: [{ kind: 'output', data: pending }],
      isFirstTake: false
    })

    const bounded = await boundSnapshot(committed, 2_000)

    expect(bounded.scrollbackLines).toBe(2_000)
    expect(bounded.outputSequence).toBe(6)
    expect(bounded.modes.kittyKeyboardFlags).toBe(1)
    expectConsecutive(numberedRowIds(replayedRows(bounded)), 4_000 - (2_000 + 24 - 2), 4_000)
  })

  it('keeps older-row OSC links across a recorded resize', async () => {
    const oldLink = '\x1b]8;;https://old.example\x1b\\OLD_LINK\x1b]8;;\x1b\\\r\n'
    const stream = `${oldLink}${numberedLines(1, 1_500)}`
    const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
    write(disk, stream)
    const restoreInfo = restoreInfoFrom(disk.getSnapshot())
    const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
    write(live, stream)
    live.resize(100, 24)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo,
      pendingRecords: [{ kind: 'resize', cols: 100, rows: 24 }],
      isFirstTake: false
    })

    const oldRow = replayedRows(durable).findIndex((row) => row.startsWith('OLD_LINK'))
    expect(oldRow).toBe(0)
    expect(durable.oscLinks).toEqual([
      { row: oldRow, startCol: 0, endCol: 8, uri: 'https://old.example' }
    ])
  })

  it('keeps an older-row OSC link on its text across folds that evict rows', async () => {
    const link = '\x1b]8;;https://old.example\x1b\\OLD_LINK\x1b]8;;\x1b\\\r\n'
    let stream = `${numberedLines(1, 2_000)}${link}${numberedLines(2_001, 5_100)}`
    const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
    write(disk, stream)
    let restoreInfo = restoreInfoFrom(disk.getSnapshot())
    for (const [from, to] of [
      [5_101, 6_050],
      [6_051, 7_000]
    ]) {
      const pending = numberedLines(from, to)
      stream += pending
      const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
      write(live, stream)

      const durable = await buildDurableCheckpointSnapshot({
        liveSnapshot: live.getSnapshot(),
        restoreInfo,
        pendingRecords: [{ kind: 'output', data: pending }],
        isFirstTake: false
      })

      expect(durable.snapshotAnsi).toContain('\x1b]8;;https://old.example')
      const linkRow = replayedRows(durable).findIndex((row) => row.startsWith('OLD_LINK'))
      expect(linkRow).toBeGreaterThan(0)
      expect(durable.oscLinks).toEqual([
        { row: linkRow, startCol: 0, endCol: 8, uri: 'https://old.example' }
      ])
      restoreInfo = restoreInfoFrom(durable)
    }
  })

  it('keeps wrapped rows that straddle the live window top', async () => {
    const { restoreInfo, live, expected } = straddlingWrappedHistory()

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo,
      pendingRecords: [],
      isFirstTake: false
    })

    expect(joinedCells(durable)).toBe(expected)
  })
})

const STRADDLE_LINES = 450
const STRADDLE_LINE_LENGTH = 300

/** Four rows per line leave an orphaned continuation after 1023 rows are evicted. */
function straddlingWrappedHistory(): {
  restoreInfo: ColdRestoreInfo
  live: HeadlessEmulator
  expected: string
} {
  let stream = ''
  let expected = ''
  for (let index = 1; index <= STRADDLE_LINES; index += 1) {
    const line = `WRAP_${String(index).padStart(5, '0')}_`.padEnd(STRADDLE_LINE_LENGTH, 'x')
    stream += `${line}\r\n`
    expected += line
  }
  const disk = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS })
  write(disk, stream)
  const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS })
  write(live, stream)
  const liveTop = live.getBufferTailLines(DAEMON_SESSION_SCROLLBACK_ROWS + 24)[0]
  expect(liveTop).toMatch(/^x+$/)
  return { restoreInfo: restoreInfoFrom(disk.getSnapshot()), live, expected }
}

function joinedCells(snapshot: TerminalSnapshot): string {
  return replayedRows(snapshot)
    .map((row) => row.trimEnd())
    .join('')
}
