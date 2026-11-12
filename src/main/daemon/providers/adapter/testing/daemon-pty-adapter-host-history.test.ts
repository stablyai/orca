import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, promises as fsPromises, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { HeadlessEmulator } from '../../../emulation/headless-emulator'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import { decodeLogHeader } from '../../../history/storage/terminal-history-log'
import { HistoryReader } from '../../../history/restoration/history-reader'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
let adapter: DaemonPtyAdapter | undefined
const models: HeadlessEmulator[] = []

afterEach(async () => {
  await adapter?.disconnectOnly()
  adapter?.dispose()
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  for (const model of models.splice(0)) {
    model.dispose()
  }
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  harness = undefined
  adapter = undefined
})

async function startHostHistory(): Promise<{
  child: ReturnType<typeof createMockSubprocess>
  options: ConstructorParameters<typeof DaemonPtyAdapter>[0]
}> {
  const child = createMockSubprocess()
  harness = await startDaemonAdapterHarness(() => child, {}, { hostHistory: true })
  const options = {
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  }
  adapter = new DaemonPtyAdapter(options)
  return { child, options }
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `LINE_${String(i + 1).padStart(5, '0')}\r\n`).join(
    ''
  )
}

async function retainedText(id: string): Promise<string> {
  const snapshot = await adapter!.getBufferSnapshot(id, { scrollbackRows: 5000 })
  expect(snapshot).not.toBeNull()
  return `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
}

describe('daemon-owned terminal history', () => {
  // A non-scrolling repaint flood used to overflow main's pending pull and replace 5,000 rows with 1,023.
  it.each(['connected', 'app-restarted'] as const)(
    'keeps old, interior and newest rows through a repaint flood (%s)',
    async (connection) => {
      const { child, options } = await startHostHistory()
      const { id } = await adapter!.spawn({
        sessionId: 'host-history-flood',
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      child._simulateData(numberedLines(5000))
      if (connection === 'app-restarted') {
        await adapter!.disconnectOnly()
      }
      child._simulateData('\r\x1b[2KREPAINT'.repeat(200_000))
      if (connection === 'app-restarted') {
        adapter!.dispose()
        adapter = new DaemonPtyAdapter(options)
        const attached = await adapter.spawn({ sessionId: id, cols: 80, rows: 24, cwd: '/tmp' })
        expect(attached.snapshot).toContain('LINE_00010')
      }
      const text = await retainedText(id)
      expect(text).toContain('LINE_00010')
      expect(text).toContain('LINE_02500')
      expect(text).toContain('LINE_05000')
    },
    30_000
  )

  // The 5 MiB log cap used to publish the live 1k model as the new checkpoint.
  it('folds the retained window at the real log cap and keeps the later suffix', async () => {
    const { child } = await startHostHistory()
    const { id } = await adapter!.spawn({
      sessionId: 'host-history-fold',
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })
    child._simulateData(numberedLines(5000))
    const sgrFlood = '\x1b[0m'.repeat(16_384)
    for (let batch = 0; batch < 90; batch += 1) {
      child._simulateData(sgrFlood)
    }
    child._simulateData('AFTER_FOLD\r\n')
    const dir = join(harness!.dir, 'history', getHistorySessionDirName(id))
    await waitFor(() => {
      try {
        const checkpoint = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8'))
        return checkpoint.generation === decodeLogHeader(readFileSync(join(dir, 'output.log')))
      } catch {
        return false
      }
    }, 20_000)
    const checkpoint = readFileSync(join(dir, 'checkpoint.json'), 'utf8')
    expect(checkpoint).toContain('LINE_00010')
    expect(checkpoint).toContain('LINE_02500')
    const text = await retainedText(id)
    expect(text).toContain('LINE_00010')
    expect(text).toContain('LINE_02500')
    expect(text).toContain('LINE_05000')
    expect(text).toContain('AFTER_FOLD')
    // Ruling 00:17: a real fold declares its boundary; parser modes set before it may be lost.
    expect(harness!.server.host.historyJournals?.live(id)?.outcome(0).kind).toBe('fold')
  }, 30_000)

  it('keeps custom tab stops for every retained row under the log budget', async () => {
    const { child } = await startHostHistory()
    const { id } = await adapter!.spawn({
      sessionId: 'host-history-tabs',
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })
    child._simulateData('BASE_MARK\r\n\x1b[3g\x1b[5G\x1bH\r')
    child._simulateData('\tZ\r\n'.repeat(1500))
    const restored = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 5000 })
    models.push(restored)
    expect(restored.writeSync(await retainedText(id))).toBe(true)
    const rows = restored.getBufferTailLines(5000).filter((line) => line.trim() === 'Z')
    expect(rows).toHaveLength(1500)
    expect(rows.every((line) => line.indexOf('Z') === 4)).toBe(true)
  }, 30_000)

  // Approved D1: an unwritable shared-root marker refuses only the new start, before any process.
  it('starts no process until the shared-root hold is written, then starts normally', async () => {
    const child = createMockSubprocess()
    let spawned = 0
    harness = await startDaemonAdapterHarness(
      () => {
        spawned += 1
        return child
      },
      {},
      { hostHistory: true }
    )
    const root = join(harness.dir, 'history')
    writeFileSync(root, 'not a directory')
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: root
    })
    const request = { sessionId: 'host-history-hold', cols: 80, rows: 24, cwd: '/tmp' }
    await expect(adapter.spawn(request)).rejects.toThrow('terminal_history_unavailable')
    expect(spawned).toBe(0)

    rmSync(root)
    mkdirSync(root)
    const { id } = await adapter.spawn(request)
    expect(spawned).toBe(1)
    expect(new HistoryReader(root).probeRestorableHistory(id).status).toBe('restorable')
  }, 30_000)

  // Ruling 23:29: after a storage gap the live terminal continues, deep history stays unavailable.
  it('keeps the live window after a storage gap and never ends the gapped history cleanly', async () => {
    const { child } = await startHostHistory()
    const { id } = await adapter!.spawn({
      sessionId: 'host-history-gap',
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })
    const dir = join(harness!.dir, 'history', getHistorySessionDirName(id))
    child._simulateData(numberedLines(100))
    await waitFor(() => {
      try {
        return readFileSync(join(dir, 'output.log')).includes('LINE_00100')
      } catch {
        return false
      }
    }, 10_000)
    rmSync(join(dir, 'output.log'))
    mkdirSync(join(dir, 'output.log'))
    child._simulateData('DURING_GAP\r\n')
    await waitFor(() => harness!.server.host.historyJournals?.live(id)?.gapped === true, 10_000)
    rmSync(join(dir, 'output.log'), { recursive: true })
    child._simulateData('AFTER_DISK_RETURNS\r\n')

    expect(await adapter!.getBufferSnapshot(id, { scrollbackRows: 5000 })).toBeNull()
    const screen = await adapter!.getBufferSnapshot(id, { scrollbackRows: 0 })
    expect(screen?.data).toContain('AFTER_DISK_RETURNS')

    // Unavailable history can never authorize Sleep to stop the live terminal.
    await expect(adapter!.shutdown(id, { keepHistory: true })).rejects.toThrow()
    expect(child.kill).not.toHaveBeenCalled()

    child._simulateExit(0)
    await waitFor(() => harness!.server.host.historyJournals?.live(id) === undefined, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).endedAt).toBeNull()
  }, 30_000)

  // Perf contract: appends scale with retained bytes in 64 KiB batches, not with output callbacks.
  it.each([1_000, 10_000])(
    'batches %i output callbacks into bounded appends',
    async (count) => {
      const { child } = await startHostHistory()
      const { id } = await adapter!.spawn({
        sessionId: `host-history-batch-${count}`,
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const appends = vi.spyOn(fsPromises, 'appendFile')
      const chunk = `${'x'.repeat(98)}\r\n`
      for (let index = 0; index < count; index += 1) {
        child._simulateData(chunk)
      }
      child._simulateData('BATCH_DONE\r\n')
      const log = join(harness!.dir, 'history', getHistorySessionDirName(id), 'output.log')
      await waitFor(() => {
        try {
          return readFileSync(log).includes('BATCH_DONE')
        } catch {
          return false
        }
      }, 20_000)
      expect(appends.mock.calls.length).toBeLessThanOrEqual(Math.ceil((count * 100) / 60_000) + 2)
      appends.mockRestore()
    },
    30_000
  )

  it('sleeps after a verified capture and wakes the same history after an app restart', async () => {
    let child = createMockSubprocess()
    harness = await startDaemonAdapterHarness(
      () => (child = createMockSubprocess()),
      {},
      {
        hostHistory: true
      }
    )
    const options = {
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    }
    adapter = new DaemonPtyAdapter(options)
    const { id } = await adapter!.spawn({
      sessionId: 'host-history-sleep',
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })
    const slept = child
    slept._simulateData(numberedLines(2000))
    await adapter!.shutdown(id, { keepHistory: true })
    expect(slept.kill).toHaveBeenCalled()
    await waitFor(() => harness!.server.host.listSessions().length === 0, 10_000)

    adapter!.dispose()
    adapter = new DaemonPtyAdapter(options)
    const woken = await adapter.spawn({ sessionId: id, cols: 80, rows: 24, cwd: '/tmp' })
    expect(woken.coldRestore?.scrollback).toContain('LINE_02000')
    child._simulateData('AFTER_WAKE\r\n')
    const text = await retainedText(id)
    expect(text).toContain('LINE_00010')
    expect(text).toContain('AFTER_WAKE')
  }, 30_000)
})
