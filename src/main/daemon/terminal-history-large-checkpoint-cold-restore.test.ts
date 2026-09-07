import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'
import { LOG_HEADER_BYTES } from './terminal-history-log'
import { getHistorySessionDirName } from './history-paths'

// Guards checkpoint-only cold restore: the route taken when the daemon dies right after a
// checkpoint, so output.log is header-only and checkpoint.json is the sole recovery source.
// #10179 shipped a read cap (16MiB) under what the unbounded checkpoint writer can emit; past it
// the read threw, the catch swallowed it to checkpoint=null, and the pane reopened empty (#10479
// raised the cap; nothing pinned the round trip that the cap silently broke). The
// reader-level bound is covered in history-reader-memory.test.ts — this asserts the round trip
// through the real writer, which is what actually decides whether a user sees their scrollback.

const MARKERS = 300
const SESSION_ID = 'repo-1::/Users/dev/large-scrollback'
const COLS = 800
const ROWS = 40

// Why per-cell color: the restore seed must clear 16MiB to cover the pre-#10479 cap, and
// SGR-per-cell is how real agent/build output inflates a snapshot well past its plain-text size.
// It is also what keeps the fixture affordable — the xterm buffer costs rows x cols, so carrying
// the bytes in SGR runs instead of rows reaches 25MiB of seed from 5.5k rows rather than 26k,
// cutting this file's peak RSS from ~1.2GiB to ~800MiB. Only 8 distinct rows exist under
// (row + col) % 8, so build them once rather than per line.
const FILLER_ROWS = Array.from(
  { length: 8 },
  (_unused, row) =>
    `${Array.from({ length: COLS - 1 }, (_cell, col) => `\x1b[3${(row + col) % 8}mx`).join('')}\x1b[0m\r\n`
)

function writeLargeScrollback(emulator: HeadlessEmulator, fillerLines: number): void {
  let written = true
  for (let index = 0; index < fillerLines; index += 1) {
    written = emulator.writeSync(FILLER_ROWS[index % FILLER_ROWS.length]) && written
  }
  for (let index = 0; index < MARKERS; index += 1) {
    written = emulator.writeSync(`MARKER-${index}\r\n`) && written
  }
  // Why assert: writeSync returns false if xterm's private _core.writeSync ever goes away, which
  // would leave an empty snapshot. The size assertions below catch that, but the endedAt gate is
  // size-independent and would still pass — pinning the gate over no scrollback at all.
  expect(written).toBe(true)
}

describe('checkpoint-only cold restore of a large checkpoint', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'large-checkpoint-restore-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('recovers the full scrollback from a checkpoint larger than the pre-fix 16MiB read cap', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const emulator = new HeadlessEmulator({ cols: COLS, rows: ROWS, scrollback: 100_000 })
    writeLargeScrollback(emulator, 5_500)

    await manager.openSession(SESSION_ID, {
      cwd: '/Users/dev/large-scrollback',
      cols: COLS,
      rows: ROWS
    })
    // Why dispose first: a throwing checkpoint() must not leak the buffer for the worker's life.
    const snapshot = emulator.getSnapshot()
    emulator.dispose()
    await manager.checkpoint(SESSION_ID, snapshot)

    const sessionDir = join(dir, getHistorySessionDirName(SESSION_ID))
    // checkpoint() resets the log to its header, so this is genuinely checkpoint-only: any
    // recovered content had to come through the checkpoint read, not incremental log replay.
    expect(statSync(join(sessionDir, 'output.log')).size).toBe(LOG_HEADER_BYTES)
    expect(statSync(join(sessionDir, 'checkpoint.json')).size).toBeGreaterThan(16 * 1024 * 1024)

    const info = await reader.detectColdRestore(SESSION_ID)
    expect(info).not.toBeNull()
    // The adapter seeds a non-alt-screen restore with rehydrateSequences + snapshotAnsi.
    const seed = info!.rehydrateSequences + info!.snapshotAnsi
    expect(info!.modes.alternateScreen).toBe(false)
    for (const index of [0, MARKERS - 1]) {
      expect(seed).toContain(`MARKER-${index}`)
    }
    expect(seed.length).toBeGreaterThan(16 * 1024 * 1024)
  }, 60_000)

  // Why pinned: this gate, not any size cap, is what makes a checkpoint-only restore come back
  // blank. Two separate investigations mistook a cleanly-ended session for a size regression.
  it('restores after an unclean exit but not after a clean one, at the same checkpoint size', async () => {
    const restoreAfter = async (endCleanly: boolean): Promise<boolean> => {
      const manager = new HistoryManager(dir)
      const emulator = new HeadlessEmulator({ cols: COLS, rows: ROWS, scrollback: 100_000 })
      writeLargeScrollback(emulator, 50)
      await manager.openSession(SESSION_ID, {
        cwd: '/Users/dev/large-scrollback',
        cols: COLS,
        rows: ROWS
      })
      const snapshot = emulator.getSnapshot()
      emulator.dispose()
      await manager.checkpoint(SESSION_ID, snapshot)
      if (endCleanly) {
        await manager.closeSession(SESSION_ID, 0)
      }
      const info = await new HistoryReader(dir).detectColdRestore(SESSION_ID)
      rmSync(join(dir, getHistorySessionDirName(SESSION_ID)), { recursive: true, force: true })
      return info !== null
    }

    expect(await restoreAfter(false)).toBe(true)
    expect(await restoreAfter(true)).toBe(false)
  }, 60_000)
})
