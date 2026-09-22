import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import {
  resetSessionParseCacheForTests,
  storeSessionParseCacheEntry
} from './session-parse-cache-store'

vi.mock('node:fs/promises', { spy: true })

let root: string

beforeEach(async () => {
  vi.clearAllMocks()
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-queue-'))
  initSessionParseCachePersistence({ filePath: join(root, 'cache.json'), appVersion: 'test' })
  vi.useFakeTimers()
})

afterEach(async () => {
  await flushSessionParseCachePersist()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function scheduleSnapshot(revision: number): void {
  storeSessionParseCacheEntry(join(root, 'transcript.jsonl'), {
    mtimeMs: revision,
    sizeBytes: revision,
    platform: process.platform,
    session: null,
    resume: null
  })
  scheduleSessionParseCachePersist({
    reused: 0,
    incremental: 1,
    fullParses: 0,
    earlyStopped: 0,
    bytesRead: 1
  })
}

it('coalesces saves requested during a stalled write and flushes the latest snapshot', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    started.resolve()
    await release.promise
    await actual.writeFile(...args)
  })

  try {
    scheduleSnapshot(0)
    await vi.advanceTimersByTimeAsync(1_500)
    await started.promise

    for (let revision = 1; revision <= 24; revision++) {
      scheduleSnapshot(revision)
      await vi.advanceTimersByTimeAsync(1_500)
    }
    expect(writeFile).toHaveBeenCalledTimes(1)

    let flushed = false
    const flush = flushSessionParseCachePersist().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(false)
    release.resolve()
    await flush

    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(join(root, 'cache.json'), 'utf8'))).toMatchObject({
      entries: [[join(root, 'transcript.jsonl'), { mtimeMs: 24, sizeBytes: 24 }]]
    })
  } finally {
    release.resolve()
    await flushSessionParseCachePersist()
  }
})
