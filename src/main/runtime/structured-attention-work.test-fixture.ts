import { expect, vi } from 'vitest'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionTurnCompletionFeed } from '../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { countAttentionCollectionWork } from './attention-operation-count.test-fixture'

export function observeStructuredAttentionWork(
  host: StructuredAgentSessionHost,
  journal: AgentSessionJournal,
  store: AgentSessionRecordStore
) {
  type SnapshotCost = { phase: string; items: number; submissions: number; work: number }
  const snapshots: SnapshotCost[] = []
  const provenance: {
    caller: string | null
    snapshots: number
    candidates: number
    filters: number
  }[] = []
  let phase = 'baseline'
  let candidates = 0
  let filters = 0
  const originalObserve = StructuredAgentSessionTurnCompletionFeed.prototype.observe
  vi.spyOn(StructuredAgentSessionTurnCompletionFeed.prototype, 'observe').mockImplementation(
    function (this: StructuredAgentSessionTurnCompletionFeed, ...args) {
      const previous = phase
      phase = 'new-root'
      try {
        return originalObserve.apply(this, args)
      } finally {
        phase = previous
      }
    }
  )
  const originalSnapshot = journal.snapshot
  vi.spyOn(journal, 'snapshot').mockImplementation(() => {
    const { result, counts } = countAttentionCollectionWork(originalSnapshot)
    const cost = {
      phase,
      items: result.items.length,
      submissions: result.submissions.length,
      work: counts.callbacks + counts.copies + counts.mapValues
    }
    snapshots.push(cost)
    const countSearch = <T>(values: T[]) => {
      const find = values.find.bind(values)
      vi.spyOn(values, 'find').mockImplementation((predicate, thisArg) =>
        find((value, index, array) => {
          cost.work += 1
          return predicate.call(thisArg, value, index, array)
        })
      )
    }
    countSearch(result.items)
    countSearch(result.submissions)
    return result
  })
  const originalCandidates = store.readCommandReceiptCandidates
  vi.spyOn(store, 'readCommandReceiptCandidates').mockImplementation((...args) => {
    const result = originalCandidates(...args)
    if (phase === 'provenance') {
      candidates += 1
      if (result.verdict === 'readable') {
        const filter = result.receipts.filter.bind(result.receipts)
        vi.spyOn(result.receipts, 'filter').mockImplementation((predicate, thisArg) =>
          filter((value, index, array) => {
            filters += 1
            return predicate.call(thisArg, value, index, array)
          })
        )
      }
    }
    return result
  })
  const originalCaller = host.phoneAlertCaller
  vi.spyOn(host, 'phoneAlertCaller').mockImplementation((edge) => {
    const previous = phase
    const before = snapshots.length
    candidates = 0
    filters = 0
    phase = 'provenance'
    try {
      const caller = originalCaller(edge)
      provenance.push({ caller, snapshots: snapshots.length - before, candidates, filters })
      return caller
    } finally {
      phase = previous
    }
  })
  return {
    snapshots,
    provenance,
    reset() {
      snapshots.length = 0
      provenance.length = 0
    }
  }
}

export function assertSnapshotCosts(costs: { items: number; submissions: number; work: number }[]) {
  expect(costs.length).toBeGreaterThan(0)
  for (const cost of costs) {
    const { items: i, submissions: s } = cost
    expect(cost.work).toBeGreaterThan(i + s)
    expect(cost.work).toBeLessThanOrEqual(
      4 * (i + s) + 8 * (i * Math.ceil(Math.log2(i + 1)) + s * Math.ceil(Math.log2(s + 1)))
    )
  }
}
