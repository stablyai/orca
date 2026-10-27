/** Share newest-first journal reads; filter to the worker's own conversation before limiting so child bursts cannot crowd it out. */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

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
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const result = await host.history({ sessionId, direction: 'tail', limit }, 'own-agent')
    return { items: result.page.items, hasOlder: result.page.hasOlder }
  } catch {
    return null
  }
}

/** A lineage page: `sessionIds[i]` is the session `items[i]` was read from. */
export type StructuredLineageJournalPage = StructuredJournalPage & {
  sessionIds: readonly string[]
}

/** Bound the whole lineage oldest-session-first; unreadable current session returns null, while missing earlier history ends the page. */
export async function readStructuredLineageJournalPage(
  lineage: readonly string[]
): Promise<StructuredLineageJournalPage | null> {
  const items: AgentJournalRenderItem[] = []
  const sessionIds: string[] = []
  for (const [position, sessionId] of lineage.toReversed().entries()) {
    const remaining = STRUCTURED_JOURNAL_PAGE_LIMIT - items.length
    if (remaining <= 0) {
      return { items, sessionIds, hasOlder: true }
    }
    const page = await readStructuredJournalPage(sessionId, remaining)
    if (!page) {
      return position === 0 ? null : { items, sessionIds, hasOlder: true }
    }
    items.unshift(...page.items)
    sessionIds.unshift(...page.items.map(() => sessionId))
    if (page.hasOlder) {
      return { items, sessionIds, hasOlder: true }
    }
  }
  return { items, sessionIds, hasOlder: false }
}

/** For retired unreadable tails, return the latest readable history and count every skipped session. */
export async function readRetiredLineageJournalPage(
  lineage: readonly string[]
): Promise<{ page: StructuredLineageJournalPage | null; unreadable: number }> {
  for (let unreadable = 1; unreadable < lineage.length; unreadable += 1) {
    const page = await readStructuredLineageJournalPage(lineage.slice(0, -unreadable))
    if (page) {
      return { page, unreadable }
    }
  }
  return { page: null, unreadable: lineage.length }
}
