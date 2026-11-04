import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Optional display bytes yield to the complete canonical response. */
export function withMailDisplayReports<T extends object>(
  journal: AgentSessionJournal,
  response: T,
  items: readonly { itemId: string; body: { kind: string } | AgentJournalMessageItem }[],
  maxBytes: number
): T {
  const canonical = 'mailDisplayReports' in response ? { ...response } : response
  if (canonical !== response) {
    Reflect.deleteProperty(canonical, 'mailDisplayReports')
  }
  const mailDisplayReports = journal.mailDisplayReports?.project(items)
  if (!mailDisplayReports) {
    return canonical
  }
  const projected = { ...canonical, mailDisplayReports }
  return Buffer.byteLength(JSON.stringify(projected)) <= maxBytes ? projected : canonical
}
