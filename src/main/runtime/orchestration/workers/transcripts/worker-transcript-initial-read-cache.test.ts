import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'

/** Stats run for real. One held for a path is chosen when called, signals once it has sampled,
 *  and answers with that sample when released. */
const stats = vi.hoisted(() => {
  const holds: { path: string; sampled: () => void; released: Promise<void> }[] = []
  return { holds }
})
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof FsPromises>()
  return {
    ...actual,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper calls the real stat with the same arguments and answers with its value.
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const index = stats.holds.findIndex((hold) => hold.path === String(args[0]))
      const hold = index !== -1 ? stats.holds.splice(index, 1)[0] : undefined
      const value = await actual.stat(...args)
      if (hold) {
        hold.sampled()
        await hold.released
      }
      return value
    }) as typeof actual.stat
  }
})

const { observeTranscriptAdmissions, readInitialWorkerTranscriptReusing, settledTranscriptPages } =
  await import('./worker-transcript-initial-read-cache')

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const directories: string[] = []
const releases: (() => void)[] = []
const pending: Promise<unknown>[] = []
afterEach(async () => {
  observeTranscriptAdmissions(undefined)
  stats.holds.splice(0)
  for (const release of releases.splice(0)) {
    release()
  }
  await Promise.allSettled(pending.splice(0))
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Holds the next stat of `path`, which must be called before the next await. */
function holdStat(path: string) {
  const sampled = deferred()
  const released = deferred()
  stats.holds.push({ path, sampled: sampled.resolve, released: released.promise })
  releases.push(released.resolve)
  return { sampled: sampled.promise, release: released.resolve }
}

function transcript(text = 'first'): string {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-initial-read-'))
  directories.push(directory)
  const filePath = join(directory, 'session.jsonl')
  writeFileSync(filePath, `${text}\n`)
  return filePath
}

function result(filePath: string, payloadBytes = 16): WorkerTranscriptReadResult {
  return {
    ok: true,
    filePath,
    sourceFingerprint: 'f',
    boundaryCheckpoint: 'c',
    messages: [
      {
        id: 'm',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'x'.repeat(payloadBytes) }],
        timestamp: null,
        source: 'transcript'
      }
    ],
    nextOffset: statSync(filePath).size,
    limited: false,
    clipping: [],
    warnings: []
  }
}

/** Scans that signal when they start and wait until released; every start keeps its handle. */
function heldScans() {
  const started: { path: string; release: () => void }[] = []
  const waiters: { count: number; reached: () => void }[] = []
  const scan = (filePath: string) => async () => {
    const release = deferred()
    started.push({ path: filePath, release: release.resolve })
    releases.push(release.resolve)
    for (const waiter of waiters.filter((waiter) => started.length >= waiter.count)) {
      waiter.reached()
    }
    await release.promise
    return result(filePath)
  }
  const startedCount = (count: number) => {
    const reached = deferred()
    waiters.push({ count, reached: reached.resolve })
    if (started.length >= count) {
      reached.resolve()
    }
    return reached.promise
  }
  const release = (filePath: string) => {
    for (const entry of started.filter((entry) => entry.path === filePath)) {
      entry.release()
    }
  }
  return { started, startedCount, release, scan }
}

const decoder = () => null
const read = (filePath: string, run: () => Promise<WorkerTranscriptReadResult>) => {
  const reading = readInitialWorkerTranscriptReusing(filePath, [20, decoder], run)
  pending.push(reading)
  return reading
}
const immediate =
  (filePath: string, counter: { scans: number }, payloadBytes = 16) =>
  () => {
    counter.scans++
    return Promise.resolve(result(filePath, payloadBytes))
  }

/** The next admission decision, as the cache makes it. */
function nextAdmission(): Promise<string> {
  return new Promise((resolve) => observeTranscriptAdmissions(resolve))
}

it.each([12, 120])(
  'shares one scan per file among %i read at once, past the settled limit',
  async (files) => {
    const scans = heldScans()
    const paths = Array.from({ length: files }, () => transcript())
    const reads = paths.map((path) => read(path, scans.scan(path)))
    await scans.startedCount(files)
    const chosen = paths[3] ?? ''

    const admitted = nextAdmission()
    const again = read(chosen, scans.scan(chosen))
    expect(await admitted).toBe('join')
    observeTranscriptAdmissions(undefined)

    for (const path of paths.filter((path) => path !== chosen)) {
      scans.release(path)
    }
    await Promise.all(reads.filter((_, index) => paths[index] !== chosen))
    scans.release(chosen)
    await Promise.all([reads[3], again])
    await read(chosen, scans.scan(chosen))

    expect(scans.started).toHaveLength(files)
    expect(settledTranscriptPages().entries).toBeLessThanOrEqual(16)
  }
)

it.each(['older first', 'newer first'])(
  'keeps the newer version reusable when two first samples arrive together, %s',
  async (order) => {
    const filePath = transcript()
    const counter = { scans: 0 }
    await read(filePath, immediate(filePath, counter))
    const older = holdStat(filePath)
    const a = read(filePath, immediate(filePath, counter))
    await older.sampled
    appendFileSync(filePath, 'second version\n')
    const newer = holdStat(filePath)
    const b = read(filePath, immediate(filePath, counter))
    await newer.sampled

    if (order === 'older first') {
      older.release()
      newer.release()
    } else {
      newer.release()
      older.release()
    }
    await Promise.all([a, b])
    const before = counter.scans
    await read(filePath, immediate(filePath, counter))

    expect(counter.scans).toBe(before)
    expect(settledTranscriptPages(filePath).entries).toBe(1)
  }
)

it("never lets a delayed old read replace a newer version's entry", async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  const after = deferred()
  const armed = deferred()
  const held: { stat?: ReturnType<typeof holdStat> } = {}
  const older = read(filePath, async () => {
    counter.scans++
    await after.promise
    // Its after-read stat samples the first version but answers late.
    held.stat = holdStat(filePath)
    armed.resolve()
    return result(filePath)
  })
  after.resolve()
  await armed.promise
  await held.stat?.sampled
  appendFileSync(filePath, 'second version\n')
  await read(filePath, immediate(filePath, counter))
  held.stat?.release()
  await older

  await Promise.all([
    read(filePath, immediate(filePath, counter)),
    read(filePath, immediate(filePath, counter))
  ])

  expect(counter.scans).toBe(2)
})

it('discards a delayed first observation that a newer one overtook', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  const held = holdStat(filePath)
  const delayed = read(filePath, immediate(filePath, counter))
  await held.sampled
  appendFileSync(filePath, 'second version\n')
  await read(filePath, immediate(filePath, counter))
  held.release()
  await delayed

  expect(counter.scans).toBe(1)
})

it('settles a variant read while another of the same version is in flight', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  const scans = heldScans()
  const first = read(filePath, scans.scan(filePath))
  await scans.startedCount(1)
  await readInitialWorkerTranscriptReusing(filePath, [21, decoder], immediate(filePath, counter))
  scans.release(filePath)
  await first

  await read(filePath, immediate(filePath, counter))
  await readInitialWorkerTranscriptReusing(filePath, [21, decoder], immediate(filePath, counter))

  expect(scans.started.length + counter.scans).toBe(2)
  expect(settledTranscriptPages(filePath).entries).toBe(2)
})

it('retires an old version when a new one is seen, even if its scan fails', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  await read(filePath, immediate(filePath, counter))
  expect(settledTranscriptPages(filePath).entries).toBe(1)
  appendFileSync(filePath, 'second version\n')

  await expect(read(filePath, () => Promise.reject(new Error('scan failed')))).rejects.toThrow()

  expect(settledTranscriptPages(filePath).entries).toBe(0)
})

it('keeps one version per file within its budgets, and no page over 512 KiB', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  for (let version = 0; version < 20; version++) {
    appendFileSync(filePath, `append ${version}\n`)
    await read(filePath, immediate(filePath, counter, 64 * 1024))
  }
  expect(settledTranscriptPages(filePath).entries).toBe(1)

  const big = transcript()
  const served = await read(big, immediate(big, counter, 600 * 1024))
  expect(served.ok && served.messages[0]?.blocks).toHaveLength(1)
  expect(settledTranscriptPages(big).entries).toBe(0)
  expect(settledTranscriptPages().bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
})

it('rereads a same-size rewrite whose modification time was put back', async () => {
  const filePath = transcript('first')
  const counter = { scans: 0 }
  await read(filePath, immediate(filePath, counter))
  const { atime, mtime } = statSync(filePath)
  writeFileSync(filePath, 'after\n')
  utimesSync(filePath, atime, mtime)

  await read(filePath, immediate(filePath, counter))

  expect(counter.scans).toBe(2)
})

it('never settles a scan the file changed under, a failure, or another variant', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  await read(filePath, async () => {
    const scanned = await immediate(filePath, counter)()
    appendFileSync(filePath, 'written during the scan\n')
    return scanned
  })
  await read(filePath, immediate(filePath, counter))
  expect(counter.scans).toBe(2)

  const otherDecoder = () => null
  await expect(
    readInitialWorkerTranscriptReusing(filePath, [20, otherDecoder], async () => {
      throw new Error('old decoder failed')
    })
  ).rejects.toThrow('old decoder failed')
  await read(filePath, immediate(filePath, counter))
  expect(counter.scans).toBe(2)
})
