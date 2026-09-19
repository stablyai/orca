/**
 * The one tail read every structured-journal reader shares.
 *
 * `worker-read`, the release archive and `terminal read` all want the same thing — the newest page
 * of a session's reduced timeline, and `null` rather than a throw when the session is not attached.
 * It lives here so none of them can drift onto a different page size or a different failure shape.
 */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

export const STRUCTURED_JOURNAL_PAGE_LIMIT = 200

export type StructuredJournalPage = {
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
}

/** The newest page of a session's journal, or null when this runtime cannot read it. */
export function readStructuredJournalPage(sessionId: string): StructuredJournalPage | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const result = host.history({
      sessionId,
      direction: 'tail',
      limit: STRUCTURED_JOURNAL_PAGE_LIMIT
    })
    return { items: result.page.items, hasOlder: result.page.hasOlder }
  } catch {
    return null
  }
}
