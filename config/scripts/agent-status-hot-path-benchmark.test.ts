/**
 * Deterministic benchmark for the renderer agent-status hot path.
 *
 * It is written so the SAME file can be checked out onto a baseline revision and re-run: it only
 * touches API that exists on both sides of the memoization change. Run it on the baseline and on
 * the candidate on one machine and diff the JSON artifact.
 *
 * Counting passes patch `Map`/`Set`/`Object.assign`/`Object.values`, which deoptimizes them, so
 * counts and timings are taken in separate passes and never from the same run.
 *
 * Scale mirrors the reporting user rather than the 100-worktree fixture in
 * docs/reference/renderer-agent-status-performance.md: 423 worktrees, 634 terminal tabs.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusBatchUpdate } from '@/store/slices/agent-status'
import {
  createTestStore,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import {
  createAgentStatusPaneRoutingIndex,
  resolvePaneKeyFromRoutingIndex
} from '@/hooks/ipc-events/agent-status-pane-routing-index'
import { resolvePaneKey } from '@/hooks/ipc-events/agent-status-routing'

const WORKTREES = 423
const EVENTS = 1_000
const BATCH_SIZE = 8
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const BASE_TIME = 2_000_000_000

const counters = { maps: 0, sets: 0, tabComparisons: 0 }

const NativeMap = globalThis.Map
const NativeSet = globalThis.Set
const nativeArrayIterator = Array.prototype[Symbol.iterator]

function withAllocationCounting<T>(run: () => T): T {
  class CountingMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries)
      counters.maps += 1
    }
  }
  class CountingSet<V> extends NativeSet<V> {
    constructor(values?: readonly V[] | null) {
      super(values)
      counters.sets += 1
    }
  }
  counters.maps = 0
  counters.sets = 0
  globalThis.Map = CountingMap as unknown as MapConstructor
  globalThis.Set = CountingSet as unknown as SetConstructor
  try {
    return run()
  } finally {
    globalThis.Map = NativeMap
    globalThis.Set = NativeSet
  }
}

/** Tab list whose iteration is observable, so the nested-loop resolver's comparisons are countable. */
class CountingTabList<T> extends Array<T> {
  [Symbol.iterator](): IterableIterator<T> {
    const inner = nativeArrayIterator.call(this) as IterableIterator<T>
    const wrapped: IterableIterator<T> = {
      next: () => {
        const result = inner.next()
        if (!result.done) {
          counters.tabComparisons += 1
        }
        return result
      },
      [Symbol.iterator]: () => wrapped
    }
    return wrapped
  }
}

function buildFixture(countTabIteration: boolean) {
  const store = createTestStore()
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  const worktrees = []
  const paneKeys: string[] = []
  const owners: { tabId: string; worktreeId: string }[] = []
  for (let index = 0; index < WORKTREES; index += 1) {
    const worktreeId = `wt-${index}`
    worktrees.push(makeWorktree({ id: worktreeId, repoId: TEST_REPO.id }))
    const tabs = []
    const unified = []
    for (let tab = 0; tab < (index % 2 === 0 ? 1 : 2); tab += 1) {
      const tabId = `tab-${index}-${tab}`
      tabs.push(makeTab({ id: tabId, worktreeId, title: `Terminal ${index}-${tab}` }))
      unified.push(
        makeUnifiedTab({
          id: tabId,
          worktreeId,
          groupId: `group-${index}`,
          label: `Label ${index}`
        })
      )
      paneKeys.push(makePaneKey(tabId, LEAF_ID))
      owners.push({ tabId, worktreeId })
    }
    tabsByWorktree[worktreeId] = countTabIteration
      ? (CountingTabList.from(tabs) as unknown as typeof tabs)
      : tabs
    unifiedTabsByWorktree[worktreeId] = unified
  }
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: worktrees },
    tabsByWorktree,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId: {},
    setGeneratedTabTitlesFromAgentPrompts: () => {},
    settings: { ...store.getState().settings, tabAutoGenerateTitle: false }
  } as Partial<AppState>)
  return { store, paneKeys, owners }
}

function measure(run: () => void): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

function per1k(value: number): number {
  return Math.round((value / EVENTS) * 1000)
}

/** One burst-shaped pass: a fresh index per batch, one pane resolution per event. */
function runIndexedRouting(store: ReturnType<typeof createTestStore>, paneKeys: string[]): void {
  for (let event = 0; event < EVENTS; event += 1) {
    if (event % BATCH_SIZE === 0) {
      store.setState({ agentStatusEpoch: event } as Partial<AppState>)
    }
    const index = createAgentStatusPaneRoutingIndex(store.getState())
    resolvePaneKeyFromRoutingIndex(index, paneKeys[event % paneKeys.length])
  }
}

function runStandaloneRouting(state: AppState, paneKeys: string[]): void {
  for (let event = 0; event < EVENTS; event += 1) {
    resolvePaneKey(state, paneKeys[event % paneKeys.length])
  }
}

function buildBatches(
  owners: { tabId: string; worktreeId: string }[],
  paneKeys: string[]
): AgentStatusBatchUpdate[][] {
  const batches: AgentStatusBatchUpdate[][] = []
  for (let event = 0; event < EVENTS; event += 1) {
    const batchIndex = Math.floor(event / BATCH_SIZE)
    const owner = owners[event % owners.length]
    batches[batchIndex] ??= []
    batches[batchIndex].push({
      paneKey: paneKeys[event % paneKeys.length],
      payload: { state: 'working', prompt: `turn ${event}`, agentType: 'claude' },
      timing: { updatedAt: BASE_TIME + event, stateStartedAt: BASE_TIME + event },
      routing: { tabId: owner.tabId, worktreeId: owner.worktreeId }
    })
  }
  return batches
}

const nextTick = (): Promise<void> =>
  new Promise((resolve) => {
    queueMicrotask(resolve)
  })

async function runCommitPass(
  store: ReturnType<typeof createTestStore>,
  batches: AgentStatusBatchUpdate[][],
  onBatch?: (elapsed: number) => void
): Promise<void> {
  for (const batch of batches) {
    const elapsed = measure(() => {
      store.getState().setAgentStatuses(batch)
    })
    onBatch?.(elapsed)
    // Each 33 ms burst is its own tick in production; let the deferred freshness scan run.
    await nextTick()
  }
}

describe('agent-status hot path benchmark', () => {
  it('reports routing, resolution and commit cost at 423 worktrees', async () => {
    const report: Record<string, number> = {}

    // Routing allocations (counting pass) and routing time (clean pass), taken separately.
    {
      const alloc = buildFixture(false)
      withAllocationCounting(() => runIndexedRouting(alloc.store, alloc.paneKeys))
      report['routing.indexed.mapAllocationsPer1kEvents'] = per1k(counters.maps)
      report['routing.indexed.setAllocationsPer1kEvents'] = per1k(counters.sets)

      const warm = buildFixture(false)
      runIndexedRouting(warm.store, warm.paneKeys)
      const clean = buildFixture(false)
      report['routing.indexed.ms'] = Number(
        measure(() => runIndexedRouting(clean.store, clean.paneKeys)).toFixed(2)
      )
    }

    // Standalone nested-loop resolution: what the leading edge used before this change.
    {
      const alloc = buildFixture(true)
      counters.tabComparisons = 0
      withAllocationCounting(() => runStandaloneRouting(alloc.store.getState(), alloc.paneKeys))
      report['routing.standalone.tabComparisonsPer1kEvents'] = per1k(counters.tabComparisons)
      report['routing.standalone.mapAllocationsPer1kEvents'] = per1k(counters.maps)

      const warm = buildFixture(false)
      runStandaloneRouting(warm.store.getState(), warm.paneKeys)
      const clean = buildFixture(false)
      report['routing.standalone.ms'] = Number(
        measure(() => runStandaloneRouting(clean.store.getState(), clean.paneKeys)).toFixed(2)
      )
    }

    // Indexed resolution under the same tab-iteration counter, for a like-for-like comparison count.
    {
      const alloc = buildFixture(true)
      counters.tabComparisons = 0
      runIndexedRouting(alloc.store, alloc.paneKeys)
      report['routing.indexed.tabComparisonsPer1kEvents'] = per1k(counters.tabComparisons)
    }

    // Store commits: 1,000 updates folded in 125 transactions, one microtask tick per transaction.
    {
      const counted = buildFixture(false)
      const nativeObjectAssign = Object.assign
      const nativeObjectValues = Object.values
      let objectAssignCalls = 0
      let objectAssignPropertyCopies = 0
      let freshnessEntryVisits = 0
      Object.assign = ((target: object, ...sources: object[]) => {
        objectAssignCalls += 1
        for (const source of sources) {
          if (source && typeof source === 'object') {
            objectAssignPropertyCopies += Object.keys(source).length
          }
        }
        return nativeObjectAssign(target, ...sources)
      }) as typeof Object.assign
      Object.values = ((value: object) => {
        const result = nativeObjectValues(value)
        freshnessEntryVisits += result.length
        return result
      }) as typeof Object.values
      const countedBatches = buildBatches(counted.owners, counted.paneKeys)
      try {
        await runCommitPass(counted.store, countedBatches)
      } finally {
        Object.assign = nativeObjectAssign
        Object.values = nativeObjectValues
      }
      report['commit.objectAssignCallsPer1kUpdates'] = per1k(objectAssignCalls)
      report['commit.stagedPropertyCopiesPer1kUpdates'] = per1k(objectAssignPropertyCopies)
      report['commit.freshnessEntryVisitsPer1kUpdates'] = per1k(freshnessEntryVisits)
      report['commit.transactions'] = countedBatches.length
      expect(Object.keys(counted.store.getState().agentStatusByPaneKey).length).toBeGreaterThan(0)

      const warm = buildFixture(false)
      await runCommitPass(warm.store, buildBatches(warm.owners, warm.paneKeys))
      const clean = buildFixture(false)
      let elapsed = 0
      await runCommitPass(clean.store, buildBatches(clean.owners, clean.paneKeys), (batchMs) => {
        elapsed += batchMs
      })
      report['commit.ms'] = Number(elapsed.toFixed(2))
    }

    const outputPath =
      process.env.ORCA_AGENT_STATUS_BENCH_OUTPUT ?? '/tmp/agent-status-hot-path-benchmark.json'
    writeFileSync(
      outputPath,
      `${JSON.stringify({ worktrees: WORKTREES, events: EVENTS, report }, null, 2)}\n`
    )
    expect(report['routing.indexed.ms']).toBeGreaterThan(0)
  })
})
