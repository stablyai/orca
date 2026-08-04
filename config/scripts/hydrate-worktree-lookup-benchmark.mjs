#!/usr/bin/env node
// Benchmark: the per-id worktree/tab lookups in session hydration and terminal reconnect.
//
// Four sites in store/slices/terminals.ts re-flattened worktreesByRepo (or tabsByWorktree)
// and linearly searched it once per loop iteration -- O(rows x ids) for O(rows + ids)
// distinct work. The fix builds one first-wins index per loop.
//
// This runs on the renderer's synchronous cold-start path and gates workspaceSessionReady,
// which blocks terminal pane mounting, so the cost is paid before the first frame.
//
// Both arms produce the resolved rows and are compared for equality before timing, so an
// index that resolved differently could not be reported as a win.
//
// Run with:  node config/scripts/hydrate-worktree-lookup-benchmark.mjs
import { performance } from 'node:perf_hooks'

const ITERATIONS = Number(process.env.ORCA_HYDRATE_BENCH_ITERATIONS ?? '60')
const WARMUP = Number(process.env.ORCA_HYDRATE_BENCH_WARMUP ?? '10')
const ROUNDS = 6

for (const [name, value] of [
  ['ORCA_HYDRATE_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_HYDRATE_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Pre-fix: re-flatten and linear-search per id.
function resolveByFlatten(worktreesByRepo, ids) {
  const resolved = []
  for (const id of ids) {
    const worktree = Object.values(worktreesByRepo)
      .flat()
      .find((entry) => entry.id === id)
    resolved.push(worktree ? worktree.repoId : null)
  }
  return resolved
}

// Post-fix: mirrors buildWorktreeByIdIndex in store/slices/worktree-by-id-index.ts.
function resolveByIndex(worktreesByRepo, ids) {
  const index = new Map()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (!index.has(worktree.id)) {
        index.set(worktree.id, worktree)
      }
    }
  }
  const resolved = []
  for (const id of ids) {
    const worktree = index.get(id)
    resolved.push(worktree ? worktree.repoId : null)
  }
  return resolved
}

function makeStore(repoCount, worktreesPerRepo) {
  const worktreesByRepo = {}
  for (let repo = 0; repo < repoCount; repo += 1) {
    const repoId = `repo-${repo}`
    worktreesByRepo[repoId] = Array.from({ length: worktreesPerRepo }, (_value, index) => ({
      id: `${repoId}/wt-${index}`,
      repoId,
      path: `/Users/dev/worktrees/${repoId}/wt-${index}`,
      branch: `feature/branch-${index}`
    }))
  }
  // Why a deliberate duplicate: `.find()` is first-wins, so an index that overwrote on
  // collision would resolve a different repo. Without a collision in the fixture that
  // difference is unobservable and the equality check below would pass a broken index.
  if (repoCount > 1) {
    const [firstRepo, secondRepo] = Object.keys(worktreesByRepo)
    worktreesByRepo[secondRepo] = [
      { ...worktreesByRepo[firstRepo][0], repoId: secondRepo },
      ...worktreesByRepo[secondRepo]
    ]
  }
  return worktreesByRepo
}

// Why a miss fraction: SSH worktrees are absent from worktreesByRepo at cold start, so
// the real workload includes ids that scan the whole list without matching -- the worst
// case for the linear arm, and the one the code comments call out explicitly.
function makeIds(worktreesByRepo, count) {
  const all = Object.values(worktreesByRepo).flat()
  const ids = Array.from({ length: count }, (_value, index) =>
    index % 7 === 0 ? `absent/wt-${index}` : all[(index * 31) % all.length].id
  )
  // Always look up the duplicated id, so first-wins is exercised, not just present.
  ids[1] = all[0].id
  return ids
}

function timeArm(resolve, worktreesByRepo, ids) {
  let sink = 0
  const start = performance.now()
  for (let index = 0; index < ITERATIONS; index += 1) {
    // Consume the result so V8 cannot drop the call as dead.
    sink += resolve(worktreesByRepo, ids).length
  }
  const elapsed = (performance.now() - start) / ITERATIONS
  if (sink === -1) {
    throw new Error('unreachable')
  }
  return elapsed
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// Arms alternate which one leads so within-round drift cannot favour either.
function measure(worktreesByRepo, ids) {
  for (let index = 0; index < WARMUP; index += 1) {
    resolveByFlatten(worktreesByRepo, ids)
    resolveByIndex(worktreesByRepo, ids)
  }
  const flattenSamples = []
  const indexSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      flattenSamples.push(timeArm(resolveByFlatten, worktreesByRepo, ids))
      indexSamples.push(timeArm(resolveByIndex, worktreesByRepo, ids))
    } else {
      indexSamples.push(timeArm(resolveByIndex, worktreesByRepo, ids))
      flattenSamples.push(timeArm(resolveByFlatten, worktreesByRepo, ids))
    }
  }
  return { flattenMs: median(flattenSamples), indexMs: median(indexSamples) }
}

const pad = (value, width) => String(value).padStart(width)
console.log('Session-hydration worktree lookup, per cold start. Lower is better.')
console.log(`iterations=${ITERATIONS} warmup=${WARMUP} rounds=${ROUNDS} (per-arm medians)`)
console.log(
  `${pad('repos', 6)} ${pad('worktrees', 10)} ${pad('ids', 5)} ${pad('flatten', 11)} ${pad('indexed', 11)} ${pad('speedup', 9)}`
)

// Row shapes are synthetic, sized against a real orca-data.json on a heavy machine
// (10 repos / 423 worktrees / 188 pending reconnect). They are not that dataset: the
// generator spreads worktrees evenly and injects one duplicate id, so treat the counts
// as "about this scale", not a replay.
for (const [repoCount, worktreesPerRepo, idCount] of [
  [1, 5, 5],
  [3, 20, 20],
  [10, 42, 188],
  [10, 100, 400]
]) {
  const worktreesByRepo = makeStore(repoCount, worktreesPerRepo)
  const ids = makeIds(worktreesByRepo, idCount)
  const flattenResult = resolveByFlatten(worktreesByRepo, ids)
  const indexResult = resolveByIndex(worktreesByRepo, ids)
  if (JSON.stringify(flattenResult) !== JSON.stringify(indexResult)) {
    throw new Error(`resolution differs at ${repoCount} repos x ${worktreesPerRepo} worktrees`)
  }
  if (!flattenResult.some((value) => value !== null)) {
    throw new Error(`fixture resolved nothing at ${repoCount} repos`)
  }
  if (!flattenResult.some((value) => value === null)) {
    throw new Error(`fixture had no absent ids at ${repoCount} repos`)
  }
  // Count the generated rows rather than multiplying: makeStore injects a duplicate
  // id for multi-repo cases, so the product would misreport the fixture by one.
  const worktreeCount = Object.values(worktreesByRepo).reduce((sum, rows) => sum + rows.length, 0)
  const { flattenMs, indexMs } = measure(worktreesByRepo, ids)
  console.log(
    `${pad(repoCount, 6)} ${pad(worktreeCount, 10)} ${pad(idCount, 5)} ${pad(`${flattenMs.toFixed(4)} ms`, 11)} ${pad(`${indexMs.toFixed(4)} ms`, 11)} ${pad(`${(flattenMs / indexMs).toFixed(1)}x`, 9)}`
  )
}

console.log(
  '\nFixtures are synthetic at real-world scale, not a replay of a real session.\nThis times one of the four lookup sites. A one-repo session sees almost nothing;\nthe win scales with worktrees x pending ids, and lands on the cold-start path that\ngates terminal pane mounting.'
)
