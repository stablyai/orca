#!/usr/bin/env node
// Benchmark: latency of loading one file diff, which reads two git blobs.
//
// The diff loaders in src/main/git/status.ts awaited their two sides in series,
// so the second `git show` could not start until the first had fully returned.
// The two reads are independent, so that serialization was pure added latency on
// every diff the review panel opens.
//
// This spawns the real `git` binary against this repo, so it measures actual
// process-launch and read cost rather than a model of it. Over SSH each diff is
// one relay RPC and the two spawns run host-local inside the relay, so the same
// relative saving applies to remote-host spawn time, not to network round trips.
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITERATIONS = Number(process.env.ORCA_DIFF_BLOB_BENCH_ITERATIONS ?? '10')
const WARMUP = Number(process.env.ORCA_DIFF_BLOB_BENCH_WARMUP ?? '3')

for (const [name, value] of [
  ['ORCA_DIFF_BLOB_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_DIFF_BLOB_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}

// Pre-fix: await one side, then the other.
async function readSequential(leftRef, rightRef, filePath) {
  const left = await git(['show', '--end-of-options', `${leftRef}:${filePath}`])
  const right = await git(['show', '--end-of-options', `${rightRef}:${filePath}`])
  return left.length + right.length
}

// Post-fix: issue both, await together.
async function readConcurrent(leftRef, rightRef, filePath) {
  const [left, right] = await Promise.all([
    git(['show', '--end-of-options', `${leftRef}:${filePath}`]),
    git(['show', '--end-of-options', `${rightRef}:${filePath}`])
  ])
  return left.length + right.length
}

// Why interleaved: running one strategy's whole batch before the other's lets
// cache warming, CPU-frequency drift, and background load correlate with the
// strategy being measured. Alternating per iteration and taking medians keeps
// that drift common to both arms.
async function measureInterleaved(leftRef, rightRef, filePath) {
  for (let index = 0; index < WARMUP; index += 1) {
    await readSequential(leftRef, rightRef, filePath)
    await readConcurrent(leftRef, rightRef, filePath)
  }
  const sequentialSamples = []
  const concurrentSamples = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    // Alternate which arm goes first so neither systematically pays a cold cache.
    const sequentialFirst = index % 2 === 0
    for (const runSequential of sequentialFirst ? [true, false] : [false, true]) {
      const start = performance.now()
      await (runSequential ? readSequential : readConcurrent)(leftRef, rightRef, filePath)
      ;(runSequential ? sequentialSamples : concurrentSamples).push(performance.now() - start)
    }
  }
  const median = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  }
  return { sequential: median(sequentialSamples), concurrent: median(concurrentSamples) }
}

const head = (await git(['rev-parse', 'HEAD'])).trim()
const parent = `${head}~1`

// Files that exist on both sides, spanning small to large so the fixed spawn
// cost and the size-dependent read cost are both represented.
const CANDIDATES = [
  'src/main/git/status.ts',
  'src/shared/agent-hook-listener.ts',
  'src/renderer/src/components/TaskPage.tsx'
]

const files = []
for (const filePath of CANDIDATES) {
  try {
    await git(['cat-file', '-e', `${parent}:${filePath}`])
    await git(['cat-file', '-e', `${head}:${filePath}`])
    files.push(filePath)
  } catch {
    // Skip a path that does not exist on both sides in this checkout.
  }
}
if (files.length === 0) {
  throw new Error('no benchmark file exists at both HEAD and HEAD~1 in this checkout')
}

const pad = (value, width) => String(value).padStart(width)
console.log('One file diff = two git blob reads. Lower is better.')
console.log(
  `iterations=${ITERATIONS} warmup=${WARMUP} (interleaved, medians) head=${head.slice(0, 9)}`
)
console.log(
  `${pad('file', 26)} ${pad('sequential', 12)} ${pad('concurrent', 12)} ${pad('speedup', 9)} ${pad('saved', 10)}`
)
for (const filePath of files) {
  const sequentialBytes = await readSequential(parent, head, filePath)
  const concurrentBytes = await readConcurrent(parent, head, filePath)
  if (sequentialBytes !== concurrentBytes) {
    throw new Error(`byte mismatch for ${filePath}`)
  }
  const { sequential, concurrent } = await measureInterleaved(parent, head, filePath)
  console.log(
    `${pad(filePath.split('/').pop(), 26)} ${pad(`${sequential.toFixed(1)} ms`, 12)} ${pad(`${concurrent.toFixed(1)} ms`, 12)} ${pad(`${(sequential / concurrent).toFixed(2)}x`, 9)} ${pad(`${(sequential - concurrent).toFixed(1)} ms`, 10)}`
  )
}
console.log(
  '\nThe saving is per diff opened, and is dominated by process launch rather than\nfile size — which is why it holds roughly constant across these files.'
)
