import {
  AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS,
  truncateOutlinePreview,
  type AgentSessionConversationOutline,
  type AgentSessionConversationOutlineEntry
} from '../../../shared/agent-session/agent-session-conversation-outline'

const DEGRADED_PREVIEW_MAX_CHARS = 60

function entryBytes(entry: AgentSessionConversationOutlineEntry): number {
  // Include the array separator.
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
}

function withPreviewCap(
  entries: readonly AgentSessionConversationOutlineEntry[],
  maxChars: number
): AgentSessionConversationOutlineEntry[] {
  return entries.map((entry) => {
    const preview = truncateOutlinePreview(entry.preview, maxChars)
    return preview === entry.preview ? entry : { ...entry, preview }
  })
}

function withoutReplies(
  entries: readonly AgentSessionConversationOutlineEntry[]
): AgentSessionConversationOutlineEntry[] {
  return entries.map(({ reply: _reply, ...entry }) => entry)
}

function totalBytes(entries: readonly AgentSessionConversationOutlineEntry[]): number {
  return entries.reduce((total, entry) => total + entryBytes(entry), 0)
}

export function boundJournalConversationOutline(
  source: Pick<AgentSessionConversationOutline, 'sessionId' | 'cursor'>,
  projected: readonly AgentSessionConversationOutlineEntry[],
  budgetBytes: number
): AgentSessionConversationOutline {
  let entries = withPreviewCap(projected, AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS)
  if (totalBytes(entries) > budgetBytes) {
    entries = withoutReplies(entries)
  }
  for (const maxChars of [DEGRADED_PREVIEW_MAX_CHARS, 0]) {
    if (totalBytes(entries) <= budgetBytes) {
      break
    }
    entries = withPreviewCap(entries, maxChars)
  }
  // Favor recent entries as likely jump targets.
  let total = totalBytes(entries)
  let first = 0
  while (total > budgetBytes && first < entries.length) {
    total -= entryBytes(entries[first])
    first += 1
  }
  return {
    sessionId: source.sessionId,
    humanMessagesOnly: true,
    cursor: source.cursor,
    entries: first === 0 ? entries : entries.slice(first),
    omittedEntries: first
  }
}
