import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Optional display bytes yield to the complete canonical response. */
export function withMailDisplayReports<T extends object>(
  journal: AgentSessionJournal,
  response: T,
  items: readonly { itemId: string; body: { kind: string } | AgentJournalMessageItem }[],
  maxBytes: number
): T {
  const mailDisplayReports = journal.mailDisplayReports?.project(items)
  if (!mailDisplayReports) {
    return response
  }
  const projected = { ...response, mailDisplayReports }
  return Buffer.byteLength(JSON.stringify(projected)) <= maxBytes ? projected : response
}
