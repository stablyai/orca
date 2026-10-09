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
