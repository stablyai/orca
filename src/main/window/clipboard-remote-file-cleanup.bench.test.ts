import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, opendir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  cleanupExpiredRemoteClipboardStaging,
  createRemoteClipboardTransferDirectory
} from './clipboard-remote-file-staging'

const BENCH_ENABLED = process.env.ORCA_CLIPBOARD_CLEANUP_BENCH === '1'
const FOREIGN_ENTRY_COUNT = Number(process.env.ORCA_CLIPBOARD_CLEANUP_BENCH_ENTRIES ?? 100_000)
const WARMUP_RUNS = 3
const SAMPLE_RUNS_PER_ARM = 24
const FIXTURE_PREFIX = 'orca-clipboard-cleanup-bench-'
const NOW_MS = 1_760_000_000_000

describe.skipIf(!BENCH_ENABLED)('remote clipboard cleanup benchmark', () => {
  let fixtureRoot = ''
  let freshTransfer = ''

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX))
    await createForeignEntries(fixtureRoot, FOREIGN_ENTRY_COUNT)
    const expiredTransfer = await createRemoteClipboardTransferDirectory(
      fixtureRoot,
      NOW_MS - 2 * 60 * 60 * 1000,
      '00000000-0000-4000-8000-000000000000'
    )
    freshTransfer = await createRemoteClipboardTransferDirectory(
      fixtureRoot,
      NOW_MS,
      '00000000-0000-4000-8000-000000000001'
    )
    const expiredAt = new Date(NOW_MS - 2 * 60 * 60 * 1000)
    await utimes(expiredTransfer, expiredAt, expiredAt)
    await cleanupExpiredRemoteClipboardStaging(fixtureRoot, NOW_MS)

    await expect(access(expiredTransfer)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(freshTransfer)).resolves.toBeUndefined()
    expect(await countForeignEntries(fixtureRoot)).toBe(FOREIGN_ENTRY_COUNT)
  }, 900_000)

  afterAll(async () => {
    if (
      fixtureRoot &&
      dirname(fixtureRoot) === tmpdir() &&
      basename(fixtureRoot).startsWith(FIXTURE_PREFIX)
    ) {
      await rm(fixtureRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      })
    }
  }, 900_000)

  it('reports shared-root and owned-parent median and p95', async () => {
    for (let index = 0; index < WARMUP_RUNS; index += 1) {
      await scanSharedTempRoot(fixtureRoot)
      await cleanupExpiredRemoteClipboardStaging(fixtureRoot, NOW_MS)
    }

    const samples = { ownedParent: [] as number[], sharedRoot: [] as number[] }
    const launchPositions = {
      ownedParent: [0, 0],
      sharedRoot: [0, 0]
    }
    for (let index = 0; index < SAMPLE_RUNS_PER_ARM; index += 1) {
      const order =
        index % 2 === 0
          ? (['sharedRoot', 'ownedParent'] as const)
          : (['ownedParent', 'sharedRoot'] as const)
      for (const [position, arm] of order.entries()) {
        launchPositions[arm][position] += 1
        samples[arm].push(
          await measure(() =>
            arm === 'sharedRoot'
              ? scanSharedTempRoot(fixtureRoot)
              : cleanupExpiredRemoteClipboardStaging(fixtureRoot, NOW_MS)
          )
        )
      }
    }

    expect(launchPositions).toEqual({
      ownedParent: [SAMPLE_RUNS_PER_ARM / 2, SAMPLE_RUNS_PER_ARM / 2],
      sharedRoot: [SAMPLE_RUNS_PER_ARM / 2, SAMPLE_RUNS_PER_ARM / 2]
    })
    expect(samples.ownedParent).toHaveLength(SAMPLE_RUNS_PER_ARM)
    expect(samples.sharedRoot).toHaveLength(SAMPLE_RUNS_PER_ARM)
    expect(await countForeignEntries(fixtureRoot)).toBe(FOREIGN_ENTRY_COUNT)
    await expect(access(freshTransfer)).resolves.toBeUndefined()
    const sharedRoot = summarize(samples.sharedRoot)
    const ownedParent = summarize(samples.ownedParent)
    console.log('correctness=pass')
    console.log(
      `sampling=ABBA positions-per-arm=${SAMPLE_RUNS_PER_ARM / 2}/${SAMPLE_RUNS_PER_ARM / 2} p95-order-drift<=1-slot`
    )
    console.log(`post12917-shared-root median=${sharedRoot.median}ms p95=${sharedRoot.p95}ms`)
    console.log(`owned-parent median=${ownedParent.median}ms p95=${ownedParent.p95}ms`)
  }, 900_000)
})

async function createForeignEntries(root: string, count: number): Promise<void> {
  const batchSize = 128
  for (let start = 0; start < count; start += batchSize) {
    const tasks: Promise<unknown>[] = []
    for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
      const target = join(root, `foreign-${String(index).padStart(8, '0')}`)
      tasks.push(index % 2 === 0 ? writeFile(target, '') : mkdir(target))
    }
    await Promise.all(tasks)
  }
}

async function countForeignEntries(root: string): Promise<number> {
  return (await readdir(root)).filter((name) => name.startsWith('foreign-')).length
}

async function scanSharedTempRoot(root: string): Promise<void> {
  const directory = await opendir(root)
  try {
    for await (const entry of directory) {
      if (entry.isDirectory() && entry.name.startsWith('orca-clipboard-file-')) {
        // Reproduces the remaining shared-root iteration after #12917.
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const startedAt = process.hrtime.bigint()
  await operation()
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

function summarize(samples: number[]): { median: string; p95: string } {
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  return { median: median.toFixed(3), p95: p95.toFixed(3) }
}
