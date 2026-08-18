import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal-scrollback-policy'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { getHistorySessionDirName } from './history-paths'
import { getDaemonSocketPath } from './daemon-spawner'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { TerminalHost } from './terminal-host'
import type { DaemonFileLog } from './daemon-file-log'
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import type { SubprocessHandle } from './session-subprocess-handle'

const PREVIOUSLY_RECOVERABLE_LINE = 'LINE_01000'
const OLDEST_WRITTEN_LINE = 'LINE_00001'
const NEWEST_WRITTEN_LINE = `LINE_${String(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT).padStart(5, '0')}`
const FRESH_AFTER_CHECKPOINT = 'FRESH_AFTER_CHECKPOINT'

function numberedOutput(lineCount: number): string {
  let output = ''
  for (let index = 1; index <= lineCount; index += 1) {
    output += `LINE_${String(index).padStart(5, '0')}\r\n`
  }
  return output
}

function snapshotText(snapshot: { scrollbackAnsi?: string; snapshotAnsi?: string }): string {
  return `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi ?? ''}`
}

function createMockSubprocess(): SubprocessHandle & {
  emitData: (data: string) => void
} {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExit?.(0), 1)),
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData(callback) {
      onData = callback
    },
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData(data) {
      onData?.(data)
    }
  }
}

function simulateAdapterCrash(adapter: DaemonPtyAdapter): void {
  const internals = adapter as unknown as {
    client: { disconnect: () => void }
    stopCheckpointTimer: () => void
  }
  internals.stopCheckpointTimer()
  internals.client.disconnect()
}

describe('STA-4091 previously recoverable restore depth', () => {
  it('live daemon memory still drops older rows so session count cannot grow unbounded', async () => {
    const subprocess = createMockSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    try {
      await host.createOrAttach({
        sessionId: 'live-window',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      subprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await vi.waitFor(() => {
        const snapshot = host.getSnapshot('live-window')
        const text = snapshotText(snapshot ?? {})
        expect(text).toContain(NEWEST_WRITTEN_LINE)
        expect(text).not.toContain(OLDEST_WRITTEN_LINE)
        expect(text).not.toContain(PREVIOUSLY_RECOVERABLE_LINE)
        expect(DAEMON_SESSION_SCROLLBACK_ROWS).toBeLessThan(
          DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
        )
      })
    } finally {
      await host.dispose()
    }
  })

  describe('durable history', () => {
    let dir: string
    let manager: HistoryManager
    let reader: HistoryReader

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'orca-restore-depth-'))
      manager = new HistoryManager(dir)
      reader = new HistoryReader(dir)
      await manager.openSession('restore-depth', { cwd: '/tmp', cols: 80, rows: 24 })
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reconstructs the previously recoverable desktop depth from incremental history', async () => {
      const records: PendingOutputRecord[] = [
        { kind: 'output', data: numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT) }
      ]
      expect(await manager.appendIncrements('restore-depth', 1, records)).toBe('ok')

      const restore = await reader.detectColdRestore('restore-depth')
      const text = snapshotText(restore ?? {})
      expect(text).toContain(OLDEST_WRITTEN_LINE)
      expect(text).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(text).toContain(NEWEST_WRITTEN_LINE)
    })

    it('keeps that depth after a production compact of the live daemon window', async () => {
      const live = new HeadlessEmulator({
        cols: 80,
        rows: 24,
        scrollback: DAEMON_SESSION_SCROLLBACK_ROWS
      })
      try {
        expect(live.writeSync(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))).toBe(true)
        const liveSnapshot = live.getSnapshot()
        expect(snapshotText(liveSnapshot)).not.toContain(PREVIOUSLY_RECOVERABLE_LINE)

        expect(
          await manager.appendIncrements('restore-depth', 1, [
            { kind: 'output', data: numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT) }
          ])
        ).toBe('ok')
        const restoreInfo = await reader.detectColdRestore('restore-depth')
        const durable = await buildDurableCheckpointSnapshot({
          liveSnapshot,
          restoreInfo
        })
        expect(await manager.checkpoint('restore-depth', durable)).toBe('committed')

        const restore = await reader.detectColdRestore('restore-depth')
        const text = snapshotText(restore ?? {})
        expect(text).toContain(NEWEST_WRITTEN_LINE)
        expect(text).toContain(PREVIOUSLY_RECOVERABLE_LINE)
        expect(text).toContain(OLDEST_WRITTEN_LINE)
        expect(DAEMON_RESTORE_SCROLLBACK_ROWS).toBe(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT)
      } finally {
        live.dispose()
      }
    })

    it('replays pending records into restore depth when disk history is empty', async () => {
      const live = new HeadlessEmulator({
        cols: 80,
        rows: 24,
        scrollback: DAEMON_SESSION_SCROLLBACK_ROWS
      })
      try {
        live.writeSync(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
        const durable = await buildDurableCheckpointSnapshot({
          liveSnapshot: live.getSnapshot(),
          restoreInfo: null,
          pendingRecords: [
            { kind: 'output', data: numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT) }
          ]
        })
        expect(snapshotText(durable)).toContain(OLDEST_WRITTEN_LINE)
        expect(snapshotText(durable)).toContain(PREVIOUSLY_RECOVERABLE_LINE)
        expect(snapshotText(durable)).toContain(NEWEST_WRITTEN_LINE)
      } finally {
        live.dispose()
      }
    })

    it('reuses restore info when there are no pending records to replay', async () => {
      const live = new HeadlessEmulator({
        cols: 80,
        rows: 24,
        scrollback: DAEMON_SESSION_SCROLLBACK_ROWS
      })
      try {
        expect(
          await manager.appendIncrements('restore-depth', 1, [
            { kind: 'output', data: numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT) }
          ])
        ).toBe('ok')
        const restoreInfo = await reader.detectColdRestore('restore-depth')
        live.writeSync(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
        const durable = await buildDurableCheckpointSnapshot({
          liveSnapshot: { ...live.getSnapshot(), outputSequence: 9 },
          restoreInfo
        })
        expect(durable.outputSequence).toBe(9)
        expect(durable.scrollbackAnsi).toBe('')
        expect(durable.scrollbackLines).toBe(restoreInfo?.scrollbackLines)
        expect(snapshotText(durable)).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      } finally {
        live.dispose()
      }
    })

    it('falls back to the live window when pending resize records are invalid', async () => {
      const liveSnapshot = {
        snapshotAnsi: 'live-only',
        scrollbackAnsi: '',
        rehydrateSequences: '',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        scrollbackLines: 0,
        modes: {
          bracketedPaste: false,
          alternateScreen: false,
          applicationCursor: false,
          mouseTracking: false
        },
        outputSequence: 4
      } as TerminalSnapshot

      const durable = await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo: null,
        pendingRecords: [{ kind: 'resize', cols: 0, rows: 24 }]
      })
      expect(durable).toBe(liveSnapshot)
    })
  })

  describe('adapter remount and restart', () => {
    let dir: string
    let historyDir: string
    let server: DaemonServer
    let adapter: DaemonPtyAdapter
    let lastSubprocess: ReturnType<typeof createMockSubprocess>

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'orca-restore-depth-adapter-'))
      historyDir = join(dir, 'history')
      const log: DaemonFileLog = { log: () => {}, close: () => {} }
      server = new DaemonServer({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        log,
        spawnSubprocess: () => {
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()
      adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        historyPath: historyDir
      })
    })

    afterEach(async () => {
      adapter?.dispose()
      await server?.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it('restores the previously recoverable depth on remount snapshot', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'remount-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      const snapshot = await adapter.getBufferSnapshot(id)
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain(NEWEST_WRITTEN_LINE)
      expect(text).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(text).toContain(OLDEST_WRITTEN_LINE)
      expect(text.split(OLDEST_WRITTEN_LINE)).toHaveLength(2)
    })

    it('honors a bounded remount snapshot depth', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'bounded-remount-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      const snapshot = await adapter.getBufferSnapshot(id, { scrollbackRows: 24 })
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain(NEWEST_WRITTEN_LINE)
      expect(text).not.toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(text).not.toContain(OLDEST_WRITTEN_LINE)
    })

    it('restores that depth after a keepHistory restart compact', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'restart-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      await adapter.shutdown(id, { immediate: true, keepHistory: true })

      const restore = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      const text = snapshotText(restore ?? {})
      expect(text).toContain(NEWEST_WRITTEN_LINE)
      expect(text).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(text).toContain(OLDEST_WRITTEN_LINE)
    })

    it('restores that depth on warm reattach', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'reattach-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      const reattach = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: id,
        cwd: '/tmp'
      })
      expect(reattach.isReattach).toBe(true)
      expect(reattach.snapshot).toContain(NEWEST_WRITTEN_LINE)
      expect(reattach.snapshot).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(reattach.snapshot).toContain(OLDEST_WRITTEN_LINE)
    })

    it('preserves durable depth across an adapter reconnect', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'adapter-reconnect-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      await adapter.disconnectOnly()
      adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        historyPath: historyDir
      })

      const reattach = await adapter.spawn({ cols: 80, rows: 24, sessionId: id, cwd: '/tmp' })
      expect(reattach.isReattach).toBe(true)
      expect(reattach.snapshot).toContain(NEWEST_WRITTEN_LINE)
      expect(reattach.snapshot).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(reattach.snapshot).toContain(OLDEST_WRITTEN_LINE)

      const restore = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restore ?? {})).toContain(OLDEST_WRITTEN_LINE)
    })

    it('uses the live window when durable history disappears after a prior drain', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'missing-history-after-drain',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const internals = adapter as unknown as { checkpointDirtySessions: () => Promise<void> }
      await internals.checkpointDirtySessions()
      rmSync(join(historyDir, getHistorySessionDirName(id), 'checkpoint.json'))
      lastSubprocess.emitData('TAIL_AFTER_HISTORY_LOSS\r\n')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const snapshot = await adapter.getBufferSnapshot(id)
        const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
        expect(text).toContain(NEWEST_WRITTEN_LINE)
        expect(text).toContain('TAIL_AFTER_HISTORY_LOSS')
        expect(text).not.toContain(OLDEST_WRITTEN_LINE)
        const restored = await new HistoryReader(historyDir).detectColdRestore(id, {
          ignoreCleanEnd: true
        })
        expect(snapshotText(restored ?? {})).toContain(NEWEST_WRITTEN_LINE)
        expect(snapshotText(restored ?? {})).toContain('TAIL_AFTER_HISTORY_LOSS')
        expect(restored?.scrollbackLines).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)
        expect(warn).toHaveBeenCalledWith(
          '[history] durable continuity unproven; using live snapshot:',
          id
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('preserves durable depth after an incremental append and adapter crash', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'incremental-crash-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const oldInternals = adapter as unknown as { checkpointDirtySessions: () => Promise<void> }
      await oldInternals.checkpointDirtySessions()
      const beforeCrash = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(beforeCrash?.pendingOutputSeq).toBe(2)
      expect(snapshotText(beforeCrash ?? {})).toContain(OLDEST_WRITTEN_LINE)

      simulateAdapterCrash(adapter)
      adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        historyPath: historyDir
      })

      const reattach = await adapter.spawn({ cols: 80, rows: 24, sessionId: id, cwd: '/tmp' })
      expect(reattach.snapshot).toContain(FRESH_AFTER_CHECKPOINT)
      expect(reattach.snapshot).toContain(OLDEST_WRITTEN_LINE)
      const restored = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restored ?? {})).toContain(OLDEST_WRITTEN_LINE)
    })

    it('uses the live window when a crashed adapter left a pending-output gap', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'incremental-gap-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const oldInternals = adapter as unknown as {
        client: { request: (method: string, params: unknown) => Promise<unknown> }
      }
      await oldInternals.client.request('takePendingOutput', {
        sessionId: id,
        includeSnapshot: false
      })
      simulateAdapterCrash(adapter)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        historyPath: historyDir
      })

      const reattach = await adapter.spawn({ cols: 80, rows: 24, sessionId: id, cwd: '/tmp' })
      expect(reattach.snapshot).toContain(FRESH_AFTER_CHECKPOINT)
      expect(reattach.snapshot).not.toContain(OLDEST_WRITTEN_LINE)
      const restored = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restored ?? {})).not.toContain(OLDEST_WRITTEN_LINE)
      expect(restored?.scrollbackLines).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)
      expect(warn).toHaveBeenCalledWith(
        '[history] durable continuity unproven; using live snapshot:',
        id
      )
    })

    // Assert durable depth, not the sequence that merely enables it.
    it('preserves durable depth when an empty incremental take precedes a warm reattach', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'empty-take-depth',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const oldInternals = adapter as unknown as { checkpointDirtySessions: () => Promise<void> }
      await oldInternals.checkpointDirtySessions()
      const beforeReattach = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(beforeReattach ?? {})).toContain(OLDEST_WRITTEN_LINE)

      // The trigger: a dirty mark with no new PTY records (the mock swallows the write, nothing echoes back).
      adapter.write(id, 'noop')
      await oldInternals.checkpointDirtySessions()

      simulateAdapterCrash(adapter)
      adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token'),
        historyPath: historyDir
      })

      const reattach = await adapter.spawn({ cols: 80, rows: 24, sessionId: id, cwd: '/tmp' })
      expect(reattach.snapshot).toContain(FRESH_AFTER_CHECKPOINT)
      expect(reattach.snapshot).toContain(OLDEST_WRITTEN_LINE)

      // First post-reattach compact runs the continuity proof; it must not flatten the deep checkpoint.
      const newInternals = adapter as unknown as {
        checkpointDirtySessions: () => Promise<void>
      }
      adapter.write(id, 'noop')
      await newInternals.checkpointDirtySessions()

      const restored = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restored ?? {})).toContain(OLDEST_WRITTEN_LINE)
      expect(snapshotText(restored ?? {})).toContain(PREVIOUSLY_RECOVERABLE_LINE)
      expect(restored?.scrollbackLines).toBeGreaterThan(DAEMON_SESSION_SCROLLBACK_ROWS)
    })

    it('falls back to the live window when durable history cannot be read', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'error-fallback',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      const internals = adapter as unknown as { historyReader: HistoryReader }
      vi.spyOn(internals.historyReader, 'detectColdRestore').mockRejectedValue(
        new Error('history unreadable')
      )

      const snapshot = await adapter.getBufferSnapshot(id)
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain(NEWEST_WRITTEN_LINE)
      expect(text).not.toContain(OLDEST_WRITTEN_LINE)
    })

    it('reanchors from the live window after pending output overflows', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'overflow-reanchor',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)

      const overflowLine = `BULK_${'x'.repeat(100)}\r\n`
      lastSubprocess.emitData(overflowLine.repeat(20_000))
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const snapshot = await adapter.getBufferSnapshot(id)
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain(FRESH_AFTER_CHECKPOINT)
      const restore = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restore ?? {})).toContain(FRESH_AFTER_CHECKPOINT)
    })

    it('reanchors after a retryable durable checkpoint', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'checkpoint-retryable',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const internals = adapter as unknown as {
        historyManager: HistoryManager
        sessionsNeedingLiveCheckpoint: Set<string>
      }
      const checkpoint = vi
        .spyOn(internals.historyManager, 'checkpoint')
        .mockResolvedValueOnce('retryable')

      const snapshot = await adapter.getBufferSnapshot(id)
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain(FRESH_AFTER_CHECKPOINT)
      expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(true)

      const recovered = await adapter.getBufferSnapshot(id)
      expect(`${recovered?.scrollbackAnsi ?? ''}${recovered?.data ?? ''}`).toContain(
        FRESH_AFTER_CHECKPOINT
      )
      const restore = await new HistoryReader(historyDir).detectColdRestore(id, {
        ignoreCleanEnd: true
      })
      expect(snapshotText(restore ?? {})).toContain(FRESH_AFTER_CHECKPOINT)
      expect(checkpoint.mock.calls.at(-1)?.[1].scrollbackLines).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)
      expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(false)

      checkpoint.mockResolvedValueOnce('retryable')
      const reattach = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: id,
        cwd: '/tmp'
      })
      expect(reattach.isReattach).toBe(true)
      expect(reattach.snapshot).toContain(FRESH_AFTER_CHECKPOINT)
    })

    it('stops retrying when durable history is unavailable', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'checkpoint-unavailable',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const internals = adapter as unknown as {
        client: { request: (method: string, params?: unknown) => Promise<unknown> }
        historyManager: HistoryManager
        sessionsNeedingFullCheckpoint: Set<string>
        sessionsNeedingLiveCheckpoint: Set<string>
        checkpointDirtySessions: () => Promise<void>
      }
      const requests = vi.spyOn(internals.client, 'request')
      const checkpoint = vi
        .spyOn(internals.historyManager, 'checkpoint')
        .mockResolvedValue('unavailable')

      const snapshot = await adapter.getBufferSnapshot(id)
      expect(`${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`).toContain(
        FRESH_AFTER_CHECKPOINT
      )
      expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(false)
      expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(false)

      await internals.checkpointDirtySessions()
      await internals.checkpointDirtySessions()
      const snapshotTakes = requests.mock.calls.filter(
        ([method, params]) =>
          method === 'takePendingOutput' &&
          (params as { includeSnapshot?: boolean } | undefined)?.includeSnapshot === true
      )
      expect(snapshotTakes).toHaveLength(1)
      expect(checkpoint).toHaveBeenCalledTimes(1)
    })

    it('uses the live window when an older daemon omits drained records', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'missing-drained-records',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)
      lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)

      const internals = adapter as unknown as {
        client: { request: (method: string, params?: unknown) => Promise<unknown> }
        historyManager: HistoryManager
      }
      const request = internals.client.request.bind(internals.client)
      vi.spyOn(internals.client, 'request').mockImplementation(async (method, params) => {
        const result = await request(method, params)
        if (
          method === 'takePendingOutput' &&
          (params as { includeSnapshot?: boolean } | undefined)?.includeSnapshot &&
          result &&
          typeof result === 'object'
        ) {
          delete (result as { drainedRecords?: PendingOutputRecord[] }).drainedRecords
        }
        return result
      })
      const checkpoint = vi.spyOn(internals.historyManager, 'checkpoint')

      const snapshot = await adapter.getBufferSnapshot(id)
      expect(`${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`).toContain(
        FRESH_AFTER_CHECKPOINT
      )
      expect(checkpoint.mock.calls.at(-1)?.[1].scrollbackLines).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)
    })

    it('uses the post-drain sequence for output produced during an overlay', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'overlay-sequence',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)

      const internals = adapter as unknown as {
        client: { request: (method: string, params?: unknown) => Promise<unknown> }
      }
      const request = internals.client.request.bind(internals.client)
      let injected = false
      vi.spyOn(internals.client, 'request').mockImplementation(async (method, params) => {
        if (
          method === 'takePendingOutput' &&
          (params as { includeSnapshot?: boolean } | undefined)?.includeSnapshot &&
          !injected
        ) {
          injected = true
          lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)
        }
        return request(method, params)
      })

      const overlaid = await adapter.getBufferSnapshot(id)
      const current = await adapter.getBufferSnapshot(id, { scrollbackRows: 24 })
      expect(`${overlaid?.scrollbackAnsi ?? ''}${overlaid?.data ?? ''}`).toContain(
        FRESH_AFTER_CHECKPOINT
      )
      expect(overlaid?.seq).toBe(current?.seq)
    })

    it('uses the post-drain sequence for output produced during warm reattach', async () => {
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'reattach-overlay-sequence',
        cwd: '/tmp'
      })
      lastSubprocess.emitData(numberedOutput(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))
      await adapter.getBufferSnapshot(id)

      const internals = adapter as unknown as {
        client: { request: (method: string, params?: unknown) => Promise<unknown> }
      }
      const request = internals.client.request.bind(internals.client)
      let injected = false
      vi.spyOn(internals.client, 'request').mockImplementation(async (method, params) => {
        if (
          method === 'takePendingOutput' &&
          (params as { includeSnapshot?: boolean } | undefined)?.includeSnapshot &&
          !injected
        ) {
          injected = true
          lastSubprocess.emitData(`${FRESH_AFTER_CHECKPOINT}\r\n`)
        }
        return request(method, params)
      })

      const reattach = await adapter.spawn({ cols: 80, rows: 24, sessionId: id, cwd: '/tmp' })
      const current = await adapter.getBufferSnapshot(id, { scrollbackRows: 24 })
      expect(reattach.snapshot).toContain(FRESH_AFTER_CHECKPOINT)
      expect(reattach.providerSequence?.value).toBe(current?.seq)
    })
  })
})
