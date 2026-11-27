// The text of the person's message a bot's turn answers, as Orca records it on the turn.
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'

const MAX_REQUEST_TEXT = 500

/** A message's text blocks, trimmed and capped; null for anything else or no text. */
export function requestTextOf(body: AgentJournalItemBody): string | null {
  if (body.kind !== 'message') {
    return null
  }
  const text = body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  return text ? text.slice(0, MAX_REQUEST_TEXT) : null
}
