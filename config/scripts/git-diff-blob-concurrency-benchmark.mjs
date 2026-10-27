#!/usr/bin/env node
// Measure real Git blob-read latency: serial two-sided diffs versus concurrent reads.
// SSH performs both spawns host-local within one RPC, so savings affect spawn/read time, not network round trips.
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

async function readSequential(leftRef, rightRef, filePath) {
  const left = await git(['show', '--end-of-options', `${leftRef}:${filePath}`])
  const right = await git(['show', '--end-of-options', `${rightRef}:${filePath}`])
  return left.length + right.length
}

async function readConcurrent(leftRef, rightRef, filePath) {
  const [left, right] = await Promise.all([
    git(['show', '--end-of-options', `${leftRef}:${filePath}`]),
    git(['show', '--end-of-options', `${rightRef}:${filePath}`])
  ])
  return left.length + right.length
}

// Interleave strategies and take medians so cache warming, CPU drift and background load affect both arms.
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

// Span file sizes to cover both fixed spawn and size-dependent read costs.
const CANDIDATES = [
  'src/main/git/status.ts',
  'src/shared/agent-hook-listener.ts',
  'src/renderer/src/components/task-page/TaskPage.tsx'
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
