// Provider preflight returns provider items only. The host's lifecycle rows are its own record, so
// a rewind that takes the provider list as the new epoch must splice those rows back beside the
// provider item each one followed.

import { parseCodexGoalJournalItemId } from '../../codex/codex-goal-journal-identity'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

type RetainedRow = AgentSessionRewindRecord['retained'][number]

export function isRetainedHostLifecycleRow(item: RetainedRow): boolean {
  return (
    readAgentJournalTurn(item.body as AgentJournalItemBody) !== null ||
    parseCodexGoalJournalItemId(item.itemId) !== null
  )
}

/** `reference` fixes where each host row sits; provider items are the ordered spine. */
export function mergeRetainedHostLifecycleRows(
  reference: readonly RetainedRow[],
  providerItems: readonly RetainedRow[]
): RetainedRow[] {
  const spineIndex = new Map(providerItems.map((item, index) => [item.itemId, index]))
  const rowsAfter = new Map<number, RetainedRow[]>()
  let anchor = -1
  for (const item of reference) {
    if (!isRetainedHostLifecycleRow(item)) {
      anchor = spineIndex.get(item.itemId) ?? anchor
    } else if (!spineIndex.has(item.itemId)) {
      rowsAfter.set(anchor, [...(rowsAfter.get(anchor) ?? []), item])
    }
  }
  const merged = [...(rowsAfter.get(-1) ?? [])]
  providerItems.forEach((item, index) => merged.push(item, ...(rowsAfter.get(index) ?? [])))
  return merged
}
