import { vi } from 'vitest'
import * as drafts from './agent-session-store-draft'
import * as attribution from './agent-session-runtime-attribution'
import { AgentSessionTabTable } from './agent-session/agent-session-tab-table'
import type { AgentSessionStoreState } from './agent-session-store-state'

/** Transparent counters on actual iterator yields, including the two death-listener passes. */
export function countStatusWriteWork() {
  const counts = {
    drafts: 0,
    recordCopies: 0,
    operationCopies: 0,
    recordDiffs: 0,
    operationDiffs: 0,
    attribution: 0,
    deathEvidence: 0,
    tabCopies: 0,
    tabComparisons: 0,
    retiredCopies: 0,
    retiredComparisons: 0
  }
  let phase: 'copy' | 'diff' | 'attribute' | 'death' = 'death'
  const observed = new WeakSet<object>()
  function watch<K, V>(map: Map<K, V>, records: boolean) {
    if (observed.has(map)) {
      return
    }
    observed.add(map)
    const iterate = map[Symbol.iterator].bind(map)
    vi.spyOn(map, Symbol.iterator).mockImplementation(function* () {
      for (const entry of iterate()) {
        if (phase === 'copy') {
          counts[records ? 'recordCopies' : 'operationCopies']++
        } else if (phase === 'diff') {
          counts[records ? 'recordDiffs' : 'operationDiffs']++
        } else if (phase === 'attribute') {
          counts.attribution++
        } else {
          counts.deathEvidence++
        }
        yield entry
      }
      return undefined
    })
  }
  function watchRetired(state: AgentSessionStoreState) {
    if (observed.has(state.retiredClaimKeys)) {
      return
    }
    observed.add(state.retiredClaimKeys)
    const iterate = state.retiredClaimKeys[Symbol.iterator].bind(state.retiredClaimKeys)
    vi.spyOn(state.retiredClaimKeys, Symbol.iterator).mockImplementation(function* () {
      for (const entry of iterate()) {
        counts.retiredCopies++
        yield entry
      }
      return undefined
    })
    const some = state.retiredClaimKeys.some.bind(state.retiredClaimKeys)
    vi.spyOn(state.retiredClaimKeys, 'some').mockImplementation((predicate, thisArg) =>
      some((entry, i, rows) => {
        counts.retiredComparisons++
        return predicate.call(thisArg, entry, i, rows)
      })
    )
  }
  const cloneTabs = AgentSessionTabTable.prototype.clone
  vi.spyOn(AgentSessionTabTable.prototype, 'clone').mockImplementation(function (
    this: AgentSessionTabTable
  ) {
    // Each constructor put copies one entry into both inverse indexes.
    const result = cloneTabs.call(this)
    counts.tabCopies += result.entries().length
    return result
  })
  const equalTabs = AgentSessionTabTable.prototype.equals
  vi.spyOn(AgentSessionTabTable.prototype, 'equals').mockImplementation(function (
    this: AgentSessionTabTable,
    other
  ) {
    const entries = this.entries
    const spy = vi.spyOn(this, 'entries').mockImplementation(() => {
      const rows = entries.call(this)
      counts.tabComparisons += rows.length
      return rows
    })
    const otherEntries = other.entries
    const otherSpy = vi.spyOn(other, 'entries').mockImplementation(() => {
      const rows = otherEntries.call(other)
      counts.tabComparisons += rows.length
      return rows
    })
    try {
      return equalTabs.call(this, other)
    } finally {
      spy.mockRestore()
      otherSpy.mockRestore()
    }
  })
  const draft = drafts.draftAgentSessionStoreState
  vi.spyOn(drafts, 'draftAgentSessionStoreState').mockImplementation((published) => {
    counts.drafts++
    watch(published.records, true)
    watch(published.operations, false)
    watchRetired(published)
    phase = 'copy'
    const next = draft(published)
    phase = 'death'
    watch(next.records, true)
    watch(next.operations, false)
    return next
  })
  const attribute = attribution.attributeAgentSessionRuntime
  vi.spyOn(attribution, 'attributeAgentSessionRuntime').mockImplementation((...args) => {
    phase = 'attribute'
    try {
      return attribute(...args)
    } finally {
      phase = 'death'
    }
  })
  const writes = drafts.agentSessionStoreDraftRowWrites
  vi.spyOn(drafts, 'agentSessionStoreDraftRowWrites').mockImplementation((...args) => {
    phase = 'diff'
    try {
      return writes(...args)
    } finally {
      phase = 'death'
    }
  })
  return {
    counts,
    reset: () => {
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0)
      }
    }
  }
}
