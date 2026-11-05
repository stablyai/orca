import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import { mapAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
// Derive outlines from the journal to avoid drift. Under the page budget, drop replies first,
// shorten then remove previews, and only then discard oldest entries.

import {
  AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS,
  projectAgentSessionConversationOutlineSteps,
  truncateOutlinePreview,
  type AgentSessionConversationOutline,
  type AgentSessionConversationOutlineEntry
} from '../../../shared/agent-session/agent-session-conversation-outline'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'

const DEGRADED_PREVIEW_MAX_CHARS = 60

function entryBytes(entry: AgentSessionConversationOutlineEntry): number {
  // Include the array separator.
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
}

function* previewCapSteps(
  entries: readonly AgentSessionConversationOutlineEntry[],
  maxChars: number
): Generator<void, AgentSessionConversationOutlineEntry[]> {
  return yield* mapAgentSessionSteps(entries, (entry) => {
    const preview = truncateOutlinePreview(entry.preview, maxChars)
    return preview === entry.preview ? entry : { ...entry, preview }
  })
}
function* totalByteSteps(
  entries: readonly AgentSessionConversationOutlineEntry[]
): Generator<void, number> {
  let total = 0
  for (const entry of entries) {
    total += entryBytes(entry)
    yield
  }
  return total
}

export function readAgentSessionConversationOutline(
  snapshot: AgentJournalSnapshot,
  budgetBytes: number = HISTORY_PAGE_CONTENT_BUDGET_BYTES
): AgentSessionConversationOutline {
  return finishJournalSteps(readAgentSessionConversationOutlineSteps(snapshot, budgetBytes))
}
export function* readAgentSessionConversationOutlineSteps(
  snapshot: AgentJournalSnapshot,
  budgetBytes: number = HISTORY_PAGE_CONTENT_BUDGET_BYTES
): Generator<void, AgentSessionConversationOutline> {
  const projected = yield* projectAgentSessionConversationOutlineSteps(
    snapshot.items,
    snapshot.submissions
  )
  let entries = yield* previewCapSteps(projected, AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS)
  if ((yield* totalByteSteps(entries)) > budgetBytes) {
    entries = yield* mapAgentSessionSteps(entries, ({ reply: _reply, ...entry }) => entry)
  }
  for (const maxChars of [DEGRADED_PREVIEW_MAX_CHARS, 0]) {
    if ((yield* totalByteSteps(entries)) <= budgetBytes) {
      break
    }
    entries = yield* previewCapSteps(entries, maxChars)
  }
  // Favor recent entries as likely jump targets.
  let total = yield* totalByteSteps(entries)
  let first = 0
  while (total > budgetBytes && first < entries.length) {
    total -= entryBytes(entries[first])
    first += 1
    yield
  }
  return {
    sessionId: snapshot.sessionId,
    cursor: snapshot.cursor,
    entries:
      first === 0
        ? entries
        : yield* mapAgentSessionSteps(tailEntries(entries, first), (entry) => entry),
    omittedEntries: first
  }
}

function* tailEntries(entries: readonly AgentSessionConversationOutlineEntry[], first: number) {
  for (let index = first; index < entries.length; index++) {
    yield entries[index]
  }
}
