import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

/** Rows below a clear floor survive unchanged; replacement rows keep their actual correspondence. */
export function remapForkChildBoundary(
  boundary: AgentSessionForkedFrom['childBoundary'],
  old: readonly AgentJournalRenderItem[],
  kept: readonly JournalReplacementItem[],
  floor?: number
): AgentSessionForkedFrom['childBoundary'] {
  if (boundary.kind === 'start') {
    return boundary
  }
  const anchorIndex = old.findIndex((row) => row.itemId === boundary.itemId)
  if (anchorIndex === -1) {
    return { kind: 'start' }
  }
  const keptIds = new Set(kept.map((row) => agentJournalItemKey(row.identity)))
  const survivor = old
    .slice(0, anchorIndex + 1)
    .findLast((row) => (floor !== undefined && row.sequence <= floor) || keptIds.has(row.itemId))
  return survivor ? { kind: 'item', itemId: survivor.itemId } : { kind: 'start' }
}
