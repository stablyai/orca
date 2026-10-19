// One journal item as a bounded-frame reader receives it: never more than one row's share of a
// frame.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'

/** One row's share of a page, so a page always carries several rows. */
export const BOUNDED_FRAME_ROW_BYTES = BOUNDED_FRAME_CONTENT_BUDGET_BYTES / 8

/** What the body may weigh once the rest of the row is paid for. */
function bodyBudget(item: AgentJournalRenderItem): number {
  return BOUNDED_FRAME_ROW_BYTES - (jsonBytes({ ...item, body: null }) - jsonBytes(null))
}

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

function boundFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const body = shortenJsonStringsToFit(item.body, bodyBudget(item))
  if (body === null) {
    return oversizedFrameItem(item)
  }
  return body === item.body ? item : { ...item, body }
}

// Items are immutable per revision, so a catch-up or a second subscriber reuses the bound form.
const bounded = new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()

export function boundedFrameItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  let result = bounded.get(item)
  if (result === undefined) {
    result = boundFrameItem(item)
    bounded.set(item, result)
  }
  return result
}
