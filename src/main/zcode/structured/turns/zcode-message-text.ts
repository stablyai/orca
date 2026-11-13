import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** The text a chat message carries; zcode sends plain text and ignores structured blocks. */
export function readMessageText(body: AgentJournalMessageItem): string | null {
  if (body.role !== 'user') {
    return null
  }
  const text = body.blocks
    .map((block) => (block.type === 'text' ? block.text : null))
    .filter((value): value is string => typeof value === 'string')
    .join('')
  return text || null
}
