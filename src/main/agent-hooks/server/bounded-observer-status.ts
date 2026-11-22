import { isTmuxInnerSubject } from '../../../shared/agent-hook-listener/presence/tmux-selected-status'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentStatusStore } from '../../../shared/agent-status/store/agent-status-store'
import type { ProgramStatusFacetStore } from './program-status/facet-store'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import { toAgentStatusIpcPayload } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function boundedObserverStatus(
  state: HookListenerState,
  programStatusFacets: ProgramStatusFacetStore,
  canonicalStatusStore: AgentStatusStore,
  worktreeId: string,
  scanLimit: number,
  rowLimit: number
) {
  const safeScanLimit = Math.max(0, Math.floor(scanLimit))
  const safeRowLimit = Math.max(0, Math.floor(rowLimit))
  const rows: ReturnType<typeof toAgentStatusIpcPayload>[] = []
  let scanned = 0
  let truncated = false
  const consume = (entry: EnrichedAgentHookEventPayload): boolean => {
    if (scanned >= safeScanLimit) {
      truncated = true
      return false
    }
    scanned += 1
    if (entry.worktreeId === worktreeId) {
      if (rows.length < safeRowLimit) {
        rows.push(toAgentStatusIpcPayload(entry))
      } else {
        truncated = true
      }
    }
    return true
  }

  for (const entry of state.lastStatusByPaneKey.values()) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows.
    const enriched = programStatusFacets.stitch(entry as EnrichedAgentHookEventPayload)
    if (!consume(enriched)) {
      break
    }
  }

  if (scanned >= safeScanLimit && !truncated) {
    truncated = canonicalStatusStore.getParents(1).length > 0
  } else if (scanned < safeScanLimit) {
    const remainingWithSentinel = safeScanLimit - scanned + 1
    for (const parent of canonicalStatusStore.getParents(remainingWithSentinel)) {
      if (!parent.status || isTmuxInnerSubject(parent.subject)) {
        if (scanned >= safeScanLimit) {
          truncated = true
          break
        }
        scanned += 1
        continue
      }
      if (!consume(structuredStatusLegacyEvent(parent.status))) {
        break
      }
    }
  }
  return { rows, truncated }
}
