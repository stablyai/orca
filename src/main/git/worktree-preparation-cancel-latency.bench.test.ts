// Opt in: ORCA_WORKTREE_PREPARATION_CANCEL_BENCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/git/worktree-preparation-cancel-latency.bench.test.ts
//
// Measures the create-side cost of an obsolete preparation: the wall time of a fresh checkout
// (the next Create's critical path) while an evicted preparation's checkout is either left running
// (main before #18951) or aborted (after). Same code, same fixture; only the abort differs.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorktreePreparationLockReason,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from '../../shared/worktree/create-preparation'
import {
  discardPreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'

const describeBench = process.env.ORCA_WORKTREE_PREPARATION_CANCEL_BENCH ? describe : describe.skip
const FILE_COUNT = Number(process.env.ORCA_WORKTREE_PREPARATION_CANCEL_BENCH_FILES ?? 6000)
const FILE_BYTES = 48 * 1024
const TRIALS = Number(process.env.ORCA_WORKTREE_PREPARATION_CANCEL_BENCH_TRIALS ?? 5)
const OBSOLETE_COUNTS = [1, 3]
const RESULT_PATH = process.env.ORCA_WORKTREE_PREPARATION_CANCEL_BENCH_RESULT

type Variant = 'running' | 'aborted'
type Sample = { variant: Variant; obsolete: number; freshCheckoutMs: number }

let root = ''
let repoPath = ''
let preparationRoot = ''
let sequence = 0

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
}

function nextPreparedPath(label: string): string {
  sequence += 1
  return join(preparationRoot, `${process.pid}-${label}-${sequence}`)
}

function checkout(preparedPath: string, signal?: AbortSignal): Promise<void> {
  return prepareWorktreeCreateCheckout(
    repoPath,
    preparedPath,
    'main',
    createWorktreePreparationLockReason(`bench-${sequence}`),
    signal ? { signal } : {}
  )
}

async function runTrial(variant: Variant, obsolete: number): Promise<Sample> {
  const controllers = Array.from({ length: obsolete }, () => new AbortController())
  const obsoletePaths = controllers.map(() => nextPreparedPath('obsolete'))
  const obsoleteWork = obsoletePaths.map((path, index) =>
    checkout(path, controllers[index].signal).catch(() => {})
  )
  if (variant === 'aborted') {
    // Eviction aborts in the same turn the incoming preparation is armed, so abort before the
    // fresh checkout starts.
    controllers.forEach((controller) => controller.abort())
  }
  const freshPath = nextPreparedPath('fresh')
  const started = performance.now()
  await checkout(freshPath)
  const freshCheckoutMs = performance.now() - started
  await Promise.all(obsoleteWork)
  await Promise.all(
    [...obsoletePaths, freshPath].map((path) =>
      discardPreparedWorktree(repoPath, path).catch(() => {})
    )
  )
  return { variant, obsolete, freshCheckoutMs }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

describeBench('obsolete preparation cancellation latency', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-preparation-cancel-bench-'))
    repoPath = join(root, 'repo')
    preparationRoot = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY)
    await mkdir(preparationRoot, { recursive: true })
    execFileSync('git', ['init', '--quiet', repoPath])
    git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(repoPath, ['config', 'user.email', 'bench@example.com'])
    git(repoPath, ['config', 'user.name', 'Bench'])
    git(repoPath, ['config', 'core.autocrlf', 'false'])
    // Unique content per file so the object store cannot dedupe the materialization work.
    for (let batch = 0; batch < FILE_COUNT; batch += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, FILE_COUNT - batch) }, (_, offset) => {
          const index = batch + offset
          return writeFile(
            join(repoPath, `payload-${index.toString().padStart(5, '0')}.txt`),
            `${index}\n`.repeat(Math.ceil(FILE_BYTES / `${index}\n`.length))
          )
        })
      )
    }
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '--quiet', '-m', 'bench fixture'])
  }, 600_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports fresh checkout wall time with obsolete checkouts running vs aborted', async () => {
    // Warm the object store and page cache once so the first variant is not penalised.
    const warm = nextPreparedPath('warm')
    await checkout(warm)
    await discardPreparedWorktree(repoPath, warm)

    const samples: Sample[] = []
    for (const obsolete of OBSOLETE_COUNTS) {
      for (let trial = 0; trial < TRIALS; trial += 1) {
        // Alternate order so drift in cache or thermal state does not favour one variant.
        const order: Variant[] = trial % 2 ? ['aborted', 'running'] : ['running', 'aborted']
        for (const variant of order) {
          samples.push(await runTrial(variant, obsolete))
        }
      }
    }
    const summary = OBSOLETE_COUNTS.map((obsolete) => {
      const pick = (variant: Variant): number[] =>
        samples
          .filter((sample) => sample.variant === variant && sample.obsolete === obsolete)
          .map((sample) => sample.freshCheckoutMs)
      const running = median(pick('running'))
      const aborted = median(pick('aborted'))
      return {
        obsolete,
        trials: TRIALS,
        freshCheckoutMedianMs: { obsoleteRunning: running, obsoleteAborted: aborted },
        speedup: running / aborted
      }
    })
    const report = JSON.stringify(
      { fixture: { files: FILE_COUNT, bytesPerFile: FILE_BYTES }, samples, summary },
      null,
      2
    )
    console.log(report)
    if (RESULT_PATH) {
      await writeFile(RESULT_PATH, `${report}\n`)
    }
    expect(existsSync(preparationRoot)).toBe(true)
  }, 900_000)
})
