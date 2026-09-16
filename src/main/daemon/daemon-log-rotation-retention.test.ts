import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryReader } from './history-reader'
import type { PendingOutputRecord } from './types'

type CheckpointAccess = {
  client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  writeSessionCheckpoint: (
    id: string,
    opts: { final: boolean; teardown: boolean }
  ) => Promise<'done' | 'deferred'>
  lastFullCheckpointAt: Map<string, number>
}

describe('log rotation retains durable history beyond the live window', () => {
  let dir: string
  let adapter: DaemonPtyAdapter
  let access: CheckpointAccess
  let live: HeadlessEmulator
  let pending: PendingOutputRecord[]
  let seq: number
  let includeDrainedRecords: boolean

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-log-rotation-'))
    adapter = new DaemonPtyAdapter({
      socketPath: join(dir, 'unused.sock'),
      tokenPath: join(dir, 'unused.token'),
      historyPath: dir
    })
    access = adapter as unknown as CheckpointAccess
    pending = []
    seq = 0
    includeDrainedRecords = true
    live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 1000 })
    access.client = {
      disconnect: vi.fn(),
      request: vi.fn(async (_method, params) => {
        const records = pending
        pending = []
        const snapshot = params.includeSnapshot ? live.getSnapshot() : null
        return {
          seq: ++seq,
          overflowed: false,
          snapshot,
          records: snapshot ? [] : records,
          ...(snapshot && includeDrainedRecords ? { drainedRecords: records } : {})
        }
      })
    }
    const manager = adapter.getHistoryManager()!
    await manager.openSession('pane', { cwd: dir, cols: 80, rows: 24 })
    const initial = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 10000 })
    try {
      const output = Array.from({ length: 6000 }, (_, i) => `original-${i}\r\n`).join('')
      initial.writeSync(output)
      live.writeSync(output)
      await manager.checkpoint('pane', initial.getSnapshot(), { pendingOutputSeq: 0 })
    } finally {
      initial.dispose()
    }
  })

  afterEach(async () => {
    live.dispose()
    await adapter.getHistoryManager()!.dispose()
    adapter.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves a rejected batch when an older writer left a nearly full log', async () => {
    const manager = adapter.getHistoryManager()!
    const padding = '\x1b[0m'.repeat(1250000)
    live.writeSync(padding)
    expect(await manager.appendIncrements('pane', ++seq, [{ kind: 'output', data: padding }])).toBe(
      'checkpoint-needed'
    )
    const data = `${'\x1b[0m'.repeat(140000)}rejected-batch\r\n`
    live.writeSync(data)
    pending.push({ kind: 'output', data })
    access.lastFullCheckpointAt.set('pane', Date.now())
    expect(await access.writeSessionCheckpoint('pane', { final: false, teardown: false })).toBe(
      'done'
    )
    const restored = await new HistoryReader(dir).detectColdRestore('pane')
    expect(restored?.snapshotAnsi.includes('original-0\r\n')).toBe(true)
    expect(restored?.snapshotAnsi.split('rejected-batch').length).toBe(2)
  })

  it.each([
    { cooldown: false, snapshotContract: 'current' },
    { cooldown: true, snapshotContract: 'current' },
    { cooldown: true, snapshotContract: 'sequence-gap' },
    { cooldown: true, snapshotContract: 'older-daemon' }
  ])(
    'rotates with $snapshotContract and cooldown=$cooldown',
    async ({ cooldown, snapshotContract }) => {
      if (cooldown) {
        access.lastFullCheckpointAt.set('pane', Date.now())
      }
      const checkpoint = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
      const write = () => access.writeSessionCheckpoint('pane', { final: false, teardown: false })
      for (let batch = 0; batch < 5; batch++) {
        const data = `${'\x1b[0m'.repeat(140000)}batch-${batch}\r\n`
        live.writeSync(data)
        pending.push({ kind: 'output', data })
        const result = await write()
        expect(result).toBe(cooldown && batch === 4 ? 'deferred' : 'done')
      }
      if (cooldown) {
        expect(checkpoint).not.toHaveBeenCalled()
        const beforeRotation = await new HistoryReader(dir).detectColdRestore('pane')
        expect(beforeRotation?.snapshotAnsi.includes('original-0\r\n')).toBe(true)
        expect(beforeRotation?.snapshotAnsi).toContain('batch-4')
        const data = 'during-cooldown\r\n'
        live.writeSync(data)
        pending.push({ kind: 'output', data })
        if (snapshotContract === 'sequence-gap') {
          seq++
        }
        if (snapshotContract === 'older-daemon') {
          includeDrainedRecords = false
        }
        access.lastFullCheckpointAt.set('pane', Date.now() - 46000)
        expect(await write()).toBe('done')
      }
      expect(checkpoint).toHaveBeenCalledTimes(1)
      const restored = await new HistoryReader(dir).detectColdRestore('pane')
      expect(restored?.snapshotAnsi.includes('original-0\r\n')).toBe(snapshotContract === 'current')
      for (let batch = 0; batch < 5; batch++) {
        expect(restored?.snapshotAnsi.split(`batch-${batch}`).length).toBe(2)
      }
      if (cooldown) {
        expect(restored?.snapshotAnsi).toContain('during-cooldown')
      }
      expect(live.getSnapshot().snapshotAnsi).not.toContain('original-0\r\n')
    }
  )
})
