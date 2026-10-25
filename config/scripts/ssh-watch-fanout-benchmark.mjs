#!/usr/bin/env node
// Compare repeated per-registration/event NFC normalization with pre-normalized root matchers/event paths for SSH watcher batches.
// Assert identical routed results before timing and import production normalizer so folding drift cannot invalidate measurement.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITERATIONS = Number(process.env.ORCA_SSH_WATCH_BENCH_ITERATIONS ?? '200')
const WARMUP = Number(process.env.ORCA_SSH_WATCH_BENCH_WARMUP ?? '30')

for (const [name, value] of [
  ['ORCA_SSH_WATCH_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_SSH_WATCH_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Recheck production normalization source: if NFC fold/cost changes, benchmark’s assumption no longer holds.
const PATH_SOURCE = readFileSync(
  new URL('../../src/shared/cross-platform-path.ts', import.meta.url),
  'utf8'
)
for (const marker of ['normalize(', 'createNormalizedPathInsideOrEqualMatcher']) {
  if (!PATH_SOURCE.includes(marker)) {
    throw new Error(`cross-platform-path.ts no longer contains ${marker}; this benchmark is stale`)
  }
}

// Import the real normalizer so both arms fold paths exactly as production does.
const {
  normalizeRuntimePathForComparison,
  isPathInsideOrEqual,
  createNormalizedPathInsideOrEqualMatcher
} = await import(new URL('../../src/shared/cross-platform-path.ts', import.meta.url).href)

// Pre-fix: mirrors the original routeSshFilesystemWatchNotification inner loop.
function routeBefore(roots, events, sink) {
  for (const rootPath of roots) {
    const matching = events.filter((event) => isPathInsideOrEqual(rootPath, event.absolutePath))
    if (matching.length > 0) {
      sink(rootPath, matching)
    }
  }
}

// Post-fix: mirrors the current implementation.
function routeAfter(roots, events, sink) {
  const normalizedEvents = events.map((event) => ({
    event,
    normalizedPath: normalizeRuntimePathForComparison(event.absolutePath)
  }))
  for (const rootPath of roots) {
    const isInsideRoot = createNormalizedPathInsideOrEqualMatcher(rootPath)
    const matching = normalizedEvents
      .filter(({ normalizedPath }) => isInsideRoot(normalizedPath))
      .map(({ event }) => event)
    if (matching.length > 0) {
      sink(rootPath, matching)
    }
  }
}

// Use real paths: length/segments determine normalization cost, which short synthetic paths understate.
const REPO_PATHS = execFileSync('git', ['ls-files'], {
  cwd: REPO_ROOT,
  maxBuffer: 256 * 1024 * 1024
})
  .toString()
  .split('\n')
  .filter(Boolean)

// Model multi-worktree host with explorer and base-directory watchers per root.
function makeRoots(count) {
  return Array.from({ length: count }, (_, index) => `/home/dev/worktrees/orca-${index}`)
}

function makeEvents(roots, count) {
  const events = []
  for (let index = 0; index < count; index += 1) {
    // Spread events across roots and include sibling paths outside them, as remote checkouts/install storms do.
    const root = index % 11 === 0 ? '/home/dev/other-checkout' : roots[index % roots.length]
    events.push({
      kind: 'update',
      absolutePath: `${root}/${REPO_PATHS[index % REPO_PATHS.length]}`
    })
  }
  return events
}

function collect(roots, events, route) {
  const seen = []
  route(roots, events, (rootPath, matching) =>
    seen.push(`${rootPath} ${matching.map((event) => event.absolutePath).join(',')}`)
  )
  return seen.join('\n')
}

// Interleave rounds and compare medians to share CPU/load drift; batch ordering alone varied observed win from 6.7x to 23.3x.
function measureInterleaved(roots, events) {
  const noop = () => undefined
  for (let index = 0; index < WARMUP; index += 1) {
    routeBefore(roots, events, noop)
    routeAfter(roots, events, noop)
  }
  const beforeSamples = []
  const afterSamples = []
  for (let round = 0; round < 5; round += 1) {
    let start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      routeBefore(roots, events, noop)
    }
    beforeSamples.push((performance.now() - start) / ITERATIONS)

    start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      routeAfter(roots, events, noop)
    }
    afterSamples.push((performance.now() - start) / ITERATIONS)
  }
  beforeSamples.sort((a, b) => a - b)
  afterSamples.sort((a, b) => a - b)
  return { beforeMs: beforeSamples[2], afterMs: afterSamples[2] }
}

const pad = (value, width) => String(value).padStart(width)
console.log('SSH fs.changed fan-out, per relay notification. Lower is better.')
console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (median of 5 rounds)`)
console.log(
  `${pad('roots', 6)} ${pad('events', 7)} ${pad('per-pair', 11)} ${pad('hoisted', 11)} ${pad('speedup', 9)}`
)

// Model ordinary 3x20 saves and large checkout/install storms up to relay’s 5,000-event batch cap.
for (const [rootCount, eventCount] of [
  [3, 20],
  [6, 50],
  [12, 200],
  [25, 500],
  [25, 5000]
]) {
  const roots = makeRoots(rootCount)
  const events = makeEvents(roots, eventCount)
  const before = collect(roots, events, routeBefore)
  const after = collect(roots, events, routeAfter)
  if (before !== after) {
    throw new Error(`routing differs at ${rootCount} roots x ${eventCount} events`)
  }
  if (!before.includes(' ')) {
    throw new Error(`fixture routed nothing at ${rootCount} roots x ${eventCount} events`)
  }
  const { beforeMs, afterMs } = measureInterleaved(roots, events)
  console.log(
    `${pad(rootCount, 6)} ${pad(eventCount, 7)} ${pad(`${beforeMs.toFixed(3)} ms`, 11)} ${pad(`${afterMs.toFixed(3)} ms`, 11)} ${pad(`${(beforeMs / afterMs).toFixed(1)}x`, 9)}`
  )
}

console.log(
  '\nThis times routing only. The saving scales with roots x events, so it is small\nfor a single-worktree session and largest during a remote checkout storm, which\nis exactly when the main process is already busy.'
)
