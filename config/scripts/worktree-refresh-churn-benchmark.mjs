#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { planWorktreeSortOrderUpdates } from '../../src/shared/worktree/sort-order-update.ts'
import { reuseEqualCatalogRows } from '../../src/renderer/src/store/slices/worktree-catalog-reconciliation.ts'

const WORKTREE_COUNT = 655
const TAB_COUNT = 1_895
const REFRESH_COUNT = 10
const ROUNDS = 15
const BATCHES_PER_ROUND = 25

function makeFixture() {
  const worktrees = Array.from({ length: WORKTREE_COUNT }, (_, index) => ({
    id: `repo-${index % 15}::/workspace/${index}`,
    sortOrder: WORKTREE_COUNT - index,
    lastActivityAt: index % 19,
    isArchived: false
  }))
  const tabs = Array.from({ length: TAB_COUNT }, (_, index) => ({
    worktreeId: worktrees[index % worktrees.length].id,
    live: index % 3 === 0
  }))
  return { worktrees, tabs }
}

function runSidebarProjection(worktrees, tabs) {
  const liveTabsByWorktree = new Map()
  for (const tab of tabs) {
    if (tab.live) {
      liveTabsByWorktree.set(tab.worktreeId, (liveTabsByWorktree.get(tab.worktreeId) ?? 0) + 1)
    }
  }
  const sorted = [...worktrees].sort(
    (left, right) =>
      (liveTabsByWorktree.get(right.id) ?? 0) - (liveTabsByWorktree.get(left.id) ?? 0) ||
      right.lastActivityAt - left.lastActivityAt ||
      right.sortOrder - left.sortOrder
  )
  return sorted.map((worktree) => worktree.id)
}

function runBaseline() {
  const fixture = makeFixture()
  const metaById = new Map(fixture.worktrees.map((worktree) => [worktree.id, worktree]))
  const requestedIds = fixture.worktrees.map((worktree) => worktree.id)
  let catalog = fixture.worktrees
  let publications = 0
  let persistenceWrites = 0
  for (let refresh = 0; refresh < REFRESH_COUNT; refresh += 1) {
    const now = 1_000_000 + refresh
    requestedIds.forEach((worktreeId, index) => {
      metaById.set(worktreeId, {
        ...metaById.get(worktreeId),
        sortOrder: now - index * 1000
      })
      persistenceWrites += 1
    })
    const incoming = structuredClone(requestedIds.map((worktreeId) => metaById.get(worktreeId)))
    const reconciled = reuseEqualCatalogRows(catalog, incoming)
    if (reconciled !== catalog) {
      catalog = reconciled
      publications += 1
      runSidebarProjection(catalog, fixture.tabs)
    }
  }
  return { publications, persistenceWrites }
}

function runCandidate() {
  const fixture = makeFixture()
  const metaById = new Map(fixture.worktrees.map((worktree) => [worktree.id, worktree]))
  const requestedIds = fixture.worktrees.map((worktree) => worktree.id)
  let catalog = fixture.worktrees
  let publications = 0
  let persistenceWrites = 0
  for (let refresh = 0; refresh < REFRESH_COUNT; refresh += 1) {
    const updates = planWorktreeSortOrderUpdates(
      requestedIds,
      (worktreeId) => metaById.get(worktreeId),
      1_000_000 + refresh
    )
    for (const update of updates) {
      metaById.set(update.worktreeId, {
        ...metaById.get(update.worktreeId),
        sortOrder: update.sortOrder
      })
    }
    persistenceWrites += updates.length
    const incoming = structuredClone(requestedIds.map((worktreeId) => metaById.get(worktreeId)))
    const reconciled = reuseEqualCatalogRows(catalog, incoming)
    if (reconciled !== catalog) {
      catalog = reconciled
      publications += 1
      runSidebarProjection(catalog, fixture.tabs)
    }
  }
  return { publications, persistenceWrites }
}

function measureBatch(run) {
  let counters
  const startedAt = performance.now()
  for (let batch = 0; batch < BATCHES_PER_ROUND; batch += 1) {
    counters = run()
  }
  return { elapsedMs: (performance.now() - startedAt) / BATCHES_PER_ROUND, counters }
}

function measureComparison() {
  runBaseline()
  runCandidate()
  const samples = Array.from({ length: ROUNDS }, (_, round) => {
    let baseline
    let candidate
    if (round % 2 === 0) {
      baseline = measureBatch(runBaseline)
      candidate = measureBatch(runCandidate)
    } else {
      candidate = measureBatch(runCandidate)
      baseline = measureBatch(runBaseline)
    }
    return { baseline, candidate, ratio: candidate.elapsedMs / baseline.elapsedMs }
  }).sort((left, right) => left.ratio - right.ratio)
  return samples[Math.floor(samples.length / 2)]
}

const { baseline, candidate } = measureComparison()
if (baseline.counters.publications !== REFRESH_COUNT || candidate.counters.publications !== 0) {
  throw new Error('Benchmark fixture no longer reproduces the refresh feedback loop')
}

console.log(
  `Worktree refresh churn: ${WORKTREE_COUNT} worktrees, ${TAB_COUNT} tabs, ${REFRESH_COUNT} refreshes`
)
console.log(
  `Before: ${baseline.elapsedMs.toFixed(3)} ms, ${baseline.counters.publications} catalog publications, ${baseline.counters.persistenceWrites} rank writes`
)
console.log(
  `After:  ${candidate.elapsedMs.toFixed(3)} ms, ${candidate.counters.publications} catalog publications, ${candidate.counters.persistenceWrites} rank writes`
)
console.log(
  `Reduction: ${((1 - candidate.elapsedMs / baseline.elapsedMs) * 100).toFixed(1)}% CPU, 100% feedback publications`
)
