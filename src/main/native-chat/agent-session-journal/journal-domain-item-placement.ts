import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Placement stays small when the writer replaces a growing text body. */
export function journalDomainItemPlacement(item: AgentJournalRenderItem): string {
  const { body: _body, ...placement } = item
  return JSON.stringify(placement)
}
