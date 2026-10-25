#!/usr/bin/env node
// Compare per-comparison localeCompare options with hoisted Intl.Collator on Source Control refresh; assert identical sorted output before timing.
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const ITERATIONS = Number(process.env.ORCA_SC_SORT_BENCH_ITERATIONS ?? '25')
const WARMUP = Number(process.env.ORCA_SC_SORT_BENCH_WARMUP ?? '5')

for (const [name, value] of [
  ['ORCA_SC_SORT_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_SC_SORT_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function conflictRank(entry) {
  if (entry.conflictStatus === 'unresolved') {
    return 0
  }
  if (entry.conflictStatus === 'resolved_locally') {
    return 1
  }
  return 2
}

// Pre-fix: resolves a collator per comparison.
function compareBefore(a, b) {
  return (
    conflictRank(a) - conflictRank(b) || a.path.localeCompare(b.path, undefined, { numeric: true })
  )
}

// Post-fix: one hoisted collator, mirroring source-control-status-sort.ts.
const collator = new Intl.Collator(undefined, { numeric: true })
function compareAfter(a, b) {
  return conflictRank(a) - conflictRank(b) || collator.compare(a.path, b.path)
}

// Use real byte-sorted Git paths: shuffled input inflates win over nearly sorted production arrays.
const REPO_PATHS = execFileSync('git', ['ls-files'], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
  maxBuffer: 256 * 1024 * 1024
})
  .toString()
  .split('\n')
  .filter(Boolean)

function makeEntries(count) {
  const step = Math.max(1, Math.floor(REPO_PATHS.length / count))
  const paths = []
  for (let index = 0; index < REPO_PATHS.length && paths.length < count; index += step) {
    paths.push(REPO_PATHS[index])
  }
  return paths.map((path, index) => ({
    path,
    area: 'unstaged',
    status: 'modified',
    ...(index % 37 === 0 ? { conflictStatus: 'unresolved' } : {})
  }))
}

function measure(compare, entries) {
  for (let index = 0; index < WARMUP; index += 1) {
    ;[...entries].sort(compare)
  }
  const samples = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      ;[...entries].sort(compare)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

const pad = (value, width) => String(value).padStart(width)
console.log('Source Control changed-file sort, per git refresh. Lower is better.')
console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (median of 5 rounds)`)
console.log(`${pad('files', 7)} ${pad('per-call', 11)} ${pad('hoisted', 11)} ${pad('speedup', 9)}`)

// Fixture sizes follow 7,324 non-merge commits: p50 3, p75 7, p90 17, p95 26, p99 63, max 1626.
for (const count of [3, 17, 26, 63, 308, 1000]) {
  const entries = makeEntries(count)
  const before = [...entries].sort(compareBefore).map((entry) => entry.path)
  const after = [...entries].sort(compareAfter).map((entry) => entry.path)
  if (before.join('\n') !== after.join('\n')) {
    throw new Error(`sort order differs at ${count} files`)
  }
  const beforeMs = measure(compareBefore, entries)
  const afterMs = measure(compareAfter, entries)
  console.log(
    `${pad(count, 7)} ${pad(`${beforeMs.toFixed(3)} ms`, 11)} ${pad(`${afterMs.toFixed(3)} ms`, 11)} ${pad(`${(beforeMs / afterMs).toFixed(1)}x`, 9)}`
  )
}
console.log(
  '\nSizes are the real changed-file distribution over 7,324 non-merge commits on\nthis repo (p50 3, p90 17, p95 26, p99 63), so the top rows are the common case.\nThis times the sort alone; the sort is roughly 85% of the Source Control\nprojection chain, so the end-to-end memo win is smaller than these ratios.'
)
