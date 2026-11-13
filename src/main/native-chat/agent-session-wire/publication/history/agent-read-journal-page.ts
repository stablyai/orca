import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { findSequenceGap } from '../../../agent-session-journal/replay/journal-cursor'
import { journalRowItemIds } from '../../../agent-session-journal/replay/journal-row-item-ids'
import { readJournalDisplayTail } from '../../../agent-session-journal/projection/journal-display-order'
import { renderJournalStatusItem } from '../../../agent-session-journal/projection/journal-public-read'

/** Where an agent read continues: rows through `sequence` are read, and the first `within`
 *  items of the next row (one row can name several). */
export type AgentReadJournalPosition = { cursor: AgentJournalCursor; within: number }

export type AgentReadJournalPage =
  | { ok: true; entries: AgentReadEntry[]; next: AgentReadJournalPosition; limited: boolean }
  | { ok: false }

/** One `orca agent read` page from a chat's journal, with work bounded by the page: a tail walks
 *  back from the newest candidate through the journal's position index, and a cursor read takes
 *  at most `limit + 1` rows and renders only the items they name. Neither renders the timeline,
 *  builds a snapshot or scans for turns. `waiting`: the live answer for a pending prompt. */
export function readAgentJournalPage(
  journal: AgentSessionJournal,
  request: { limit: number; after?: AgentReadJournalPosition },
  waiting: (itemId: string) => boolean
): AgentReadJournalPage {
  const { limit, after } = request
  if (!after) {
    const tail = readJournalDisplayTail(
      journal,
      limit,
      (item) => agentChatEntryOf(item, waiting) !== null
    )
    return {
      ok: true,
      entries: tail.items.flatMap((item) => agentChatEntryOf(item, waiting) ?? []),
      next: { cursor: journal.cursor(), within: 0 },
      limited: tail.older
    }
  }
  const since = journal.readSince(after.cursor, limit + 1)
  if (
    !since.ok ||
    (since.rows.every((row) => row.kind !== 'outcome') &&
      findSequenceGap(
        since.rows.map((row) => row.seq),
        after.cursor.sequence + 1
      )) ||
    (after.within > 0 && since.rows[0]?.seq !== after.cursor.sequence + 1)
  ) {
    return { ok: false }
  }
  const rows = since.rows.slice(0, limit)
  const position = (sequence: number, within = 0): AgentReadJournalPosition => ({
    cursor: { epoch: after.cursor.epoch, sequence },
    within
  })
  const display = journal.queuedMessages.displayState()
  const entries: AgentReadEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const ids = journalRowItemIds(row, {
      canonical: journal.canonicalItemId,
      hasSubmission: (id) => journal.submission(id) !== undefined
    })
    const start = row.seq === after.cursor.sequence + 1 ? after.within : 0
    for (let index = start; index < ids.length; index++) {
      const id = ids[index]
      const item = id === undefined || seen.has(id) ? null : renderJournalStatusItem(display, id)
      const entry = item && agentChatEntryOf(item, waiting)
      if (!entry || !id) {
        continue
      }
      if (entries.length === limit) {
        // The page is full inside this row: the next read resumes at this item.
        return { ok: true, entries, next: position(row.seq - 1, index), limited: true }
      }
      seen.add(id)
      entries.push(entry)
    }
  }
  const more = since.rows.length > rows.length
  return {
    ok: true,
    entries,
    next: position(more ? (rows.at(-1)?.seq ?? after.cursor.sequence) : since.through),
    limited: more
  }
}
