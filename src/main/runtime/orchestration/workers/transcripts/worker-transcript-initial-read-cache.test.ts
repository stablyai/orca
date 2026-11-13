import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'

/** Stats run for real; a held one resolves later with the value it read at call time. */
const stats = vi.hoisted(() => {
  const held: (() => void)[] = []
  return { holdNext: false, held }
})
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof FsPromises>()
  return {
    ...actual,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper calls the real stat with the same arguments and answers with its value.
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const value = await actual.stat(...args)
      if (!stats.holdNext) {
        return value
      }
      stats.holdNext = false
      return new Promise((resolve) => stats.held.push(() => resolve(value)))
    }) as typeof actual.stat
  }
})

const { readInitialWorkerTranscriptReusing, settledTranscriptPages } =
  await import('./worker-transcript-initial-read-cache')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function transcript(text = 'first'): string {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-initial-read-'))
  directories.push(directory)
  const filePath = join(directory, 'session.jsonl')
  writeFileSync(filePath, `${text}\n`)
  return filePath
}

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
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

/** Scans that wait until released, counting how many start. */
function heldScans() {
  const scans = { started: 0, release: new Map<string, () => void>() }
  const scan = (filePath: string) => async () => {
    scans.started++
    await new Promise<void>((resolve) => scans.release.set(filePath, resolve))
    return result(filePath)
  }
  return { scans, scan }
}

const decoder = () => null
const read = (filePath: string, run: () => Promise<WorkerTranscriptReadResult>) =>
  readInitialWorkerTranscriptReusing(filePath, [20, decoder], run)
const immediate =
  (filePath: string, counter: { scans: number }, payloadBytes = 16) =>
  () => {
    counter.scans++
    return Promise.resolve(result(filePath, payloadBytes))
  }

it.each([12, 120])(
  'shares one scan per file among %i read at once, past the settled limit',
  async (files) => {
    const { scans, scan } = heldScans()
    const paths = Array.from({ length: files }, () => transcript())
    const reads = paths.map((path) => read(path, scan(path)))
    await flush()
    const chosen = paths[3]!
    const again = read(chosen, scan(chosen))
    await flush()
    expect(scans.started).toBe(files)

    for (const path of paths.filter((path) => path !== chosen)) {
      scans.release.get(path)?.()
    }
    await Promise.all(reads.filter((_, index) => paths[index] !== chosen))
    scans.release.get(chosen)?.()
    await Promise.all([reads[3], again])
    await read(chosen, scan(chosen))

    expect(scans.started).toBe(files)
    expect(settledTranscriptPages().entries).toBeLessThanOrEqual(16)
  }
)

it("never lets a delayed old read replace a newer version's entry", async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  const { scans, scan } = heldScans()
  const older = read(filePath, scan(filePath))
  await flush()
  // Its after-read stat sees the first version but answers late.
  stats.holdNext = true
  scans.release.get(filePath)?.()
  await flush()
  appendFileSync(filePath, 'second version\n')
  await read(filePath, immediate(filePath, counter))
  stats.held.shift()?.()
  await older

  await Promise.all([
    read(filePath, immediate(filePath, counter)),
    read(filePath, immediate(filePath, counter))
  ])

  expect(scans.started + counter.scans).toBe(2)
})

it('discards a delayed first observation that a newer one overtook', async () => {
  const filePath = transcript()
  const counter = { scans: 0 }
  stats.holdNext = true
  const delayed = read(filePath, immediate(filePath, counter))
  await flush()
  appendFileSync(filePath, 'second version\n')
  await read(filePath, immediate(filePath, counter))
  stats.held.shift()?.()
  await delayed

  expect(counter.scans).toBe(1)
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
