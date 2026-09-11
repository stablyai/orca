// The Codex preflight returns provider items only. The host's turn rows are its own record, so a
// rewind that takes the provider's list as the new epoch would drop every duration before the
// boundary unless those rows are spliced back beside the item each one followed.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

type RetainedRow = AgentSessionRewindRecord['retained'][number]

export function isRetainedTurnRow(item: Pick<RetainedRow, 'body'>): boolean {
  return readAgentJournalTurn(item.body as AgentJournalItemBody) !== null
}

/** `reference` fixes where each turn row sits; the provider items are the spine and keep their
 *  own order, including turns the local journal never saw. */
export function mergeRetainedTurnRows(
  reference: readonly RetainedRow[],
  providerItems: readonly RetainedRow[]
): RetainedRow[] {
  const spineIndex = new Map(providerItems.map((item, index) => [item.itemId, index]))
  const rowsAfter = new Map<number, RetainedRow[]>()
  let anchor = -1
  for (const item of reference) {
    if (!isRetainedTurnRow(item)) {
      anchor = spineIndex.get(item.itemId) ?? anchor
    } else if (!spineIndex.has(item.itemId)) {
      rowsAfter.set(anchor, [...(rowsAfter.get(anchor) ?? []), item])
    }
  }
  const merged = [...(rowsAfter.get(-1) ?? [])]
  providerItems.forEach((item, index) => merged.push(item, ...(rowsAfter.get(index) ?? [])))
  return merged
}
