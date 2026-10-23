// One journal item as a bounded-frame reader receives it: never more than one row's share of a
// frame.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  measureHistoryItem,
  type HistoryItemForm,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'

/** One row's share of a page, so a page always carries several rows. */
export const BOUNDED_FRAME_ROW_BYTES = BOUNDED_FRAME_CONTENT_BUDGET_BYTES / 8

/** The too-large marker with every identifier it carries held to a key's bound, so the marker
 *  itself always fits a row. Provenance a reader never joins on is dropped. */
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

// Items are immutable per revision, so a catch-up or a second subscriber reuses the bound form.
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
