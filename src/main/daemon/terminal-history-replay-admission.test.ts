import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'

afterEach(() => vi.restoreAllMocks())

it('bounds disk restores and checkpoint rebuilds to one scratch grid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-replay-admission-'))
  const manager = new HistoryManager(dir)
  const reader = new HistoryReader(dir)
  const live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 1000 })
  const liveSnapshot = live.getSnapshot()
  live.dispose()
  const output = 'older-history\r\n'.repeat(10000)
  const active = new Set<HeadlessEmulator>()
  let peak = 0
  const originalWrite = HeadlessEmulator.prototype.writeSync
  const originalDispose = HeadlessEmulator.prototype.dispose
  vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementation(
    function (this: HeadlessEmulator, data) {
      active.add(this)
      peak = Math.max(peak, active.size)
      return originalWrite.call(this, data)
    }
  )
  vi.spyOn(HeadlessEmulator.prototype, 'dispose').mockImplementation(
    function (this: HeadlessEmulator) {
      active.delete(this)
      originalDispose.call(this)
    }
  )
  try {
    await manager.openSession('pane', { cwd: dir, cols: 80, rows: 24 })
    await manager.appendIncrements('pane', 1, [{ kind: 'output', data: output }])
    const [restored, ...rebuilt] = await Promise.all([
      reader.detectColdRestore('pane'),
      ...Array.from({ length: 3 }, () =>
        buildDurableCheckpointSnapshot({
          liveSnapshot,
          restoreInfo: null,
          pendingRecords: [{ kind: 'output' as const, data: output }]
        })
      )
    ])
    expect(restored?.snapshotAnsi).toContain('older-history')
    for (const snapshot of rebuilt) {
      expect(snapshot?.snapshotAnsi).toContain('older-history')
    }
    expect(peak).toBe(1)
    expect(active.size).toBe(0)
  } finally {
    await manager.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('releases scratch admission after replay fails so another session can restore', async () => {
  const live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 1000 })
  const liveSnapshot = live.getSnapshot()
  live.dispose()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementationOnce(() => {
    throw new Error('injected replay failure')
  })
  const pendingRecords = [{ kind: 'output' as const, data: 'retained-after-failure\r\n' }]
  const failed = await buildDurableCheckpointSnapshot({
    liveSnapshot,
    restoreInfo: null,
    pendingRecords
  })
  expect(failed).toBe(liveSnapshot)
  const next = await buildDurableCheckpointSnapshot({
    liveSnapshot,
    restoreInfo: null,
    pendingRecords
  })
  expect(next.snapshotAnsi).toContain('retained-after-failure')
})
