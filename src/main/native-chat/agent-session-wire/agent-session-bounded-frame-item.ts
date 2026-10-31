import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  measureHistoryItem,
  type HistoryItemForm,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'

/** Reserve room for several rows per page. */
export const BOUNDED_FRAME_ROW_BYTES = BOUNDED_FRAME_CONTENT_BUDGET_BYTES / 8

/** Bound marker identifiers so the fallback itself fits; omit provenance readers do not join on. */
function oversizedFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const {
    providerParentRef: _provenance,
    agentId,
    parentAgentId,
    turnScope,
    ...marker
  } = oversizedHistoryItem(item)
  return {
    ...marker,
    ...(agentId === undefined ? {} : { agentId: boundJournalKeyComponent(agentId) }),
    ...(parentAgentId === undefined
      ? {}
      : { parentAgentId: boundJournalKeyComponent(parentAgentId) }),
    ...(turnScope?.kind === 'turn'
      ? { turnScope: { kind: 'turn', turnItemId: boundJournalKeyComponent(turnScope.turnItemId) } }
      : turnScope === undefined
        ? {}
        : { turnScope })
  }
}

// Revision objects are immutable, so readers/subscribers may reuse the bounded form.
const bounded = new WeakMap<AgentJournalRenderItem, HistoryItemForm>()

export function boundedFrameItem(formed: HistoryItemForm): HistoryItemForm {
  const { item, bytes } = formed
  let result = bounded.get(item)
  if (result === undefined) {
    const fitted =
      shortenedAgentJournalItem(item, BOUNDED_FRAME_ROW_BYTES, bytes) ?? oversizedFrameItem(item)
    result = fitted === item ? formed : measureHistoryItem(fitted)
    bounded.set(item, result)
  }
  return result
}
