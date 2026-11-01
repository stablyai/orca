import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDaemonFileLog } from '../daemon/daemon-file-log'
import { createLocalFileSink, DROPPED_RECORD_TYPE } from './local-file-sink'

// `holdAsync` parks async appends (at open) until released; `blockSync` makes sync writes hold the thread.
const disk = vi.hoisted(() => {
  const heldWrites: (() => void)[] = []
  return { holdAsync: false, blockSync: false, heldWrites, blockingWrites: 0 }
})

const SYNC_STALL_MS = 150

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const stallSignal = new Int32Array(new SharedArrayBuffer(4))
  const blockLikeStalledDisk = (): void => {
    if (disk.blockSync) {
      disk.blockingWrites++
      Atomics.wait(stallSignal, 0, 0, SYNC_STALL_MS)
    }
  }
  const mocked = {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>): void => {
      blockLikeStalledDisk()
      actual.appendFileSync(...args)
    },
    // Overloads resolve to the last signature; the real call forwards whatever form was passed.
    writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
      blockLikeStalledDisk()
      return actual.writeSync(...args)
    }
  }
  return { ...mocked, default: mocked }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const mocked = {
    ...actual,
    open: (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
      if (!disk.holdAsync) {
        return actual.open(...args)
      }
      return new Promise((resolve, reject) => {
        disk.heldWrites.push(() => void actual.open(...args).then(resolve, reject))
      })
    }
  }
  return { ...mocked, default: mocked }
})

function stallDisk(): void {
  disk.holdAsync = true
  disk.blockSync = true
}

function releaseDisk(): void {
  disk.holdAsync = false
  disk.blockSync = false
  disk.blockingWrites = 0
  for (const run of disk.heldWrites.splice(0)) {
    run()
  }
}

async function writeIsHeld(): Promise<void> {
  await vi.waitFor(() => expect(disk.heldWrites.length).toBeGreaterThan(0), { timeout: 10_000 })
}

/** Resolves when a timer queued now gets to run. */
function nextTimer(): Promise<'ran'> {
  return new Promise((resolve) => setTimeout(() => resolve('ran'), 0))
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-stalled-log-'))
})
afterEach(() => {
  releaseDisk()
  // Windows can briefly hold a file the writer is still closing.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function readJsonLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): Record<string, unknown> => JSON.parse(line))
}

describe('log writes on a stalled disk', () => {
  it('daemon log writes leave a concurrent timer running while the write is stalled', async () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    stallDisk()
    for (let i = 0; i < 4; i++) {
      log.log('session-killed', { i })
    }
    await writeIsHeld()
    await expect(nextTimer()).resolves.toBe('ran')
    expect(disk.heldWrites).toHaveLength(1)
    expect(disk.blockingWrites).toBe(0)
    releaseDisk()
    await vi.waitFor(() => expect(readJsonLines(filePath)).toHaveLength(4), { timeout: 10_000 })
    log.close()
  })

  it('trace writes leave a concurrent timer running while the write is stalled', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 1 })
    stallDisk()
    for (let i = 0; i < 40; i++) {
      sink.push({ i })
    }
    await writeIsHeld()
    await expect(nextTimer()).resolves.toBe('ran')
    expect(disk.heldWrites).toHaveLength(1)
    expect(disk.blockingWrites).toBe(0)
    releaseDisk()
    await sink.flushAsync()
    expect(readJsonLines(filePath)).toHaveLength(40)
    sink.close()
  })

  it('daemon close writes the fatal line while an earlier write is still in flight', async () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    disk.holdAsync = true
    log.log('before-hold')
    await writeIsHeld()
    log.log('uncaught-exception-fatal')
    log.close()
    const events = (): unknown[] => readJsonLines(filePath).map((line) => line.event)
    expect(events()).toEqual(['uncaught-exception-fatal', 'daemon-log-closed'])
    releaseDisk()
    await vi.waitFor(() => expect(events()).toContain('before-hold'), { timeout: 10_000 })
  })

  it('a crash-boundary trace flush lands while an earlier write is still in flight', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 1 })
    disk.holdAsync = true
    sink.push({ name: 'before-hold' })
    await writeIsHeld()
    sink.push({ name: 'app_relaunch_requested' })
    sink.flush()
    expect(readJsonLines(filePath)).toEqual([{ name: 'app_relaunch_requested' }])
    releaseDisk()
    await sink.flushAsync()
    expect(readJsonLines(filePath)).toContainEqual({ name: 'before-hold' })
    sink.close()
  })

  it('flushAsync waits for its own records, not ones logged while it waits', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 1 })
    const heldCount = (count: number): Promise<void> =>
      vi.waitFor(() => expect(disk.heldWrites).toHaveLength(count), { timeout: 10_000 })
    disk.holdAsync = true
    sink.push({ batch: 'a' })
    let flushed = false
    const flushing = sink.flushAsync().then(() => {
      flushed = true
    })
    await heldCount(1)
    sink.push({ batch: 'b' })
    disk.heldWrites.shift()?.()
    // Batch b is now held; flush must not wait for it.
    await heldCount(1)
    await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 10_000 })
    expect(disk.heldWrites).toHaveLength(1)
    releaseDisk()
    await flushing
    await sink.flushAsync()
    sink.close()
  })

  it('two concurrent flushes both wait for lines queued behind an in-flight batch', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 100_000 })
    disk.holdAsync = true
    sink.push({ name: 'A' })
    const firstBatch = sink.flushAsync()
    await writeIsHeld()
    sink.push({ name: 'L' })
    const first = sink.flushAsync()
    const second = sink.flushAsync()
    releaseDisk()
    await second
    expect(readJsonLines(filePath)).toContainEqual({ name: 'L' })
    await Promise.all([first, firstBatch])
    sink.close()
  })

  it('flush resolves right after a crash-boundary flush that follows a finished batch', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 100_000 })
    sink.push({ name: 'a' })
    await sink.flushAsync()
    sink.push({ name: 'b' })
    sink.flush()
    let flushed = false
    void sink.flushAsync().then(() => {
      flushed = true
    })
    await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 10_000 })
    expect(readJsonLines(filePath)).toEqual([{ name: 'a' }, { name: 'b' }])
    sink.close()
  })

  it('drops the oldest daemon entries when full, so the fatal line still lands', async () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath, { maxQueuedChars: 2_000 })
    disk.holdAsync = true
    log.log('tick', { i: -1 })
    await writeIsHeld()
    for (let i = 0; i < 200; i++) {
      log.log('tick', { i })
    }
    log.log('uncaught-exception-fatal')
    log.close()
    const events = (): unknown[] => readJsonLines(filePath).map((line) => line.event)
    expect(events()).toContain('uncaught-exception-fatal')
    releaseDisk()
    const ticksWritten = (): unknown[] =>
      readJsonLines(filePath).flatMap((line) => (line.event === 'tick' ? [line.i] : []))
    // The held batch lands after the synchronous close.
    await vi.waitFor(() => expect(ticksWritten()).toContain(-1), { timeout: 10_000 })

    const lines = readJsonLines(filePath)
    const ticks = lines.filter((line) => line.event === 'tick')
    const markers = lines.filter((line) => line.event === 'log-entries-dropped')
    expect(ticks.length).toBeLessThan(201)
    expect(markers.map((line) => line.count)).toEqual([201 - ticks.length])
    expect(ticks.map((line) => line.i)).toContain(199)
  })

  it('drops trace records past the queue cap and reports the count once writes recover', async () => {
    const filePath = join(dir, 'trace.ndjson')
    const sink = createLocalFileSink({ filePath, batchWindowMs: 1, maxQueuedChars: 2_000 })
    disk.holdAsync = true
    sink.push({ i: -1 })
    await writeIsHeld()
    for (let i = 0; i < 200; i++) {
      sink.push({ i, payload: 'x'.repeat(40) })
    }
    releaseDisk()
    await sink.flushAsync()
    sink.push({ recovered: true })
    await sink.flushAsync()

    const lines = readJsonLines(filePath)
    const records = lines.filter((line) => typeof line.i === 'number')
    const marker = lines.find((line) => line.type === DROPPED_RECORD_TYPE)
    expect(records.length).toBeLessThan(201)
    expect(marker).toMatchObject({ reason: 'queue-full', droppedRecords: 201 - records.length })
    expect(lines.at(-1)).toEqual({ recovered: true })
    sink.close()
  })
})
