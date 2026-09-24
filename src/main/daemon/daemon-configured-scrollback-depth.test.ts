import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX } from '../../shared/terminal-scrollback-policy'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'

describe('configured scrollback survives durable replay', () => {
  let dir: string
  let manager: HistoryManager
  let reader: HistoryReader
  let live: HeadlessEmulator

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-configured-scrollback-'))
    manager = new HistoryManager(dir)
    reader = new HistoryReader(dir)
    live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 1000 })
    await manager.openSession('pane', { cwd: dir, cols: 80, rows: 24 })
  })

  afterEach(async () => {
    live.dispose()
    await manager.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('retains 50,000 requested rows through checkpoint plus incremental replay', async () => {
    const output = Array.from(
      { length: DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX },
      (_, i) => `history-${String(i).padStart(5, '0')}\r\n`
    ).join('')
    live.writeSync(output)
    await manager.appendIncrements('pane', 1, [{ kind: 'output', data: output }])
    const restored = await reader.detectColdRestore('pane')
    expect(restored?.snapshotAnsi).toContain('history-00000')
    const checkpoint = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo: restored,
      pendingRecords: [{ kind: 'output', data: 'after-checkpoint\r\n' }],
      scrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
    })
    expect(checkpoint.snapshotAnsi).toContain('history-00000')
    expect(await manager.checkpoint('pane', checkpoint, { pendingOutputSeq: 2 })).toBe('committed')
    await manager.appendIncrements('pane', 3, [{ kind: 'output', data: 'after-restart\r\n' }])
    const restarted = await new HistoryReader(dir).detectColdRestore('pane')
    expect(restarted?.snapshotAnsi).toContain('history-00000')
    expect(restarted?.snapshotAnsi).toContain('after-checkpoint')
    expect(restarted?.snapshotAnsi).toContain('after-restart')
    expect(restarted?.scrollbackLines).toBeLessThanOrEqual(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX)
  })

  it('still trims a snapshot to the requested smaller depth', async () => {
    const output = Array.from({ length: 12000 }, (_, i) => `history-${i}\r\n`).join('')
    live.writeSync(output)
    await manager.appendIncrements('pane', 1, [{ kind: 'output', data: output }])
    const snapshot = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo: await reader.detectColdRestore('pane'),
      scrollbackRows: 2000
    })
    expect(snapshot.snapshotAnsi).not.toContain('history-1000\r\n')
    expect(snapshot.snapshotAnsi).toContain('history-11999')
    expect(snapshot.scrollbackLines).toBe(2000)
  })
})
