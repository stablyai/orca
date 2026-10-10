/**
 * The one tail read every structured-journal reader shares.
 *
 * `worker-read`, the release archive and `terminal read` all want the same thing — the newest page
 * of a session's reduced timeline, and `null` rather than a throw when the session is not attached.
 * It lives here so none of them can drift onto a different page size or a different failure shape.
 *
 * Each reads the worker's own conversation: the newest page of its OWN rows, windowed before the
 * limit so a subagent's burst cannot crowd them out. A subagent's rows are that subagent's, and a
 * reader of the worker must never take them for the worker's words; the worker's spawn roster,
 * which stays, is the one line that says a subagent ran.
 */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

export const STRUCTURED_JOURNAL_PAGE_LIMIT = 200

export type StructuredJournalPage = {
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
}

/** The newest page of a session's journal, or null when this runtime cannot read it. A closed
 *  conversation is opened for the read; that starts no agent. */
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

/**
 * The newest page of a whole `/clear` lineage, oldest session first, under the one page limit: the
 * worker's conversation, not only the session running it now. Null when the running session (the
 * last) cannot be read; an unreadable earlier session ends the page there and counts as older history.
 */
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

/**
 * For a lineage whose running session cannot be read and is retired: the newest page of the latest
 * sessions that can still be read, walking back past every unreadable trailing one. `unreadable`
 * counts those skipped (all of them when `page` is null).
 */
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
