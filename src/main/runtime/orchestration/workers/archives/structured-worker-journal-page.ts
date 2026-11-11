/** Share newest-first journal reads; filter to the worker's own conversation before limiting so child bursts cannot crowd it out. */

import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

export const STRUCTURED_JOURNAL_PAGE_LIMIT = 200

export type StructuredJournalPage = {
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
}

/** Read newest journal items; opening a closed conversation starts no agent, and unreadable returns null. */
export async function readStructuredJournalPage(
  sessionId: string,
  limit = STRUCTURED_JOURNAL_PAGE_LIMIT
): Promise<StructuredJournalPage | null> {
  const page = await readSessionHistoryPage(sessionId, limit)
  return page ? { items: page.items, hasOlder: page.hasOlder } : null
}

async function readSessionHistoryPage(
  sessionId: string,
  limit: number,
  before?: AgentJournalCursor
): Promise<AgentSessionHistoryPage | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const result = await host.history(
      before
        ? { sessionId, direction: 'before', cursor: before, limit }
        : { sessionId, direction: 'tail', limit },
      'own-agent'
    )
    // A reset answers a cursor read with a tail page, which would splice newer items below older ones.
    return before && !result.ok ? null : result.page
  } catch {
    return null
  }
}

/** A lineage page: `sessionIds[i]` is the session `items[i]` was read from. */
export type StructuredLineageJournalPage = StructuredJournalPage & {
  sessionIds: readonly string[]
}

/**
 * Bound the whole lineage oldest-session-first; unreadable current session returns null, while missing earlier history ends the page.
 * Without `filled` the page is the newest STRUCTURED_JOURNAL_PAGE_LIMIT items; with it, history is paged back until `filled` holds.
 */
export async function readStructuredLineageJournalPage(
  lineage: readonly string[],
  filled?: (items: readonly AgentJournalRenderItem[]) => boolean
): Promise<StructuredLineageJournalPage | null> {
  const items: AgentJournalRenderItem[] = []
  const sessionIds: string[] = []
  for (const [position, sessionId] of lineage.toReversed().entries()) {
    let before: AgentJournalCursor | undefined
    for (;;) {
      const limit = filled
        ? filled(items)
          ? 0
          : STRUCTURED_JOURNAL_PAGE_LIMIT
        : STRUCTURED_JOURNAL_PAGE_LIMIT - items.length
      if (limit <= 0) {
        return { items, sessionIds, hasOlder: true }
      }
      const page = await readSessionHistoryPage(sessionId, limit, before)
      if (!page) {
        return position === 0 && !before ? null : { items, sessionIds, hasOlder: true }
      }
      items.unshift(...page.items)
      sessionIds.unshift(...page.items.map(() => sessionId))
      if (!page.hasOlder) {
        break
      }
      // An empty page cannot move its cursor back, so paging would not end.
      if (!filled || page.items.length === 0) {
        return { items, sessionIds, hasOlder: true }
      }
      before = page.window.nextCursor
    }
  }
  return { items, sessionIds, hasOlder: false }
}

/** For retired unreadable tails, return the latest readable history and count every skipped session. */
export async function readRetiredLineageJournalPage(
  lineage: readonly string[],
  filled?: (items: readonly AgentJournalRenderItem[]) => boolean
): Promise<{ page: StructuredLineageJournalPage | null; unreadable: number }> {
  for (let unreadable = 1; unreadable < lineage.length; unreadable += 1) {
    const page = await readStructuredLineageJournalPage(lineage.slice(0, -unreadable), filled)
    if (page) {
      return { page, unreadable }
    }
  }
  return { page: null, unreadable: lineage.length }
}
