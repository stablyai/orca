import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'
import { LOG_HEADER_BYTES } from './terminal-history-log'
import { getHistorySessionDirName } from './history-paths'

// Exercise real writer-to-reader recovery above the retired 16 MiB cap with a header-only log.

const MARKERS = 300
const SESSION_ID = 'repo-1::/Users/dev/large-scrollback'
const COLS = 800
const ROWS = 40

// Per-cell SGR crosses the retired byte cap with fewer buffer rows; cache the eight repeated row variants.
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
  // A missing private sync API would otherwise let the clean-end test pass with an empty snapshot.
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
    // Release the large buffer even if checkpointing later fails.
    const snapshot = emulator.getSnapshot()
    emulator.dispose()
    await manager.checkpoint(SESSION_ID, snapshot)

    const sessionDir = join(dir, getHistorySessionDirName(SESSION_ID))
    // Require checkpoint-only recovery, with no incremental output available.
    expect(statSync(join(sessionDir, 'output.log')).size).toBe(LOG_HEADER_BYTES)
    expect(statSync(join(sessionDir, 'checkpoint.json')).size).toBeGreaterThan(16 * 1024 * 1024)

    const info = await reader.detectColdRestore(SESSION_ID)
    expect(info).not.toBeNull()
    const seed = info!.rehydrateSequences + info!.snapshotAnsi
    expect(info!.modes.alternateScreen).toBe(false)
    for (const index of [0, MARKERS - 1]) {
      expect(seed).toContain(`MARKER-${index}`)
    }
    expect(seed.length).toBeGreaterThan(16 * 1024 * 1024)
  }, 60_000)

  // Keep clean-end gating distinct from checkpoint size regressions.
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
