import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { findSequenceGap } from '../../../agent-session-journal/replay/journal-cursor'
import { journalRowItemIds } from '../../../agent-session-journal/replay/journal-row-item-ids'
import { journalAgentReadIndex } from '../../../agent-session-journal/projection/journal-agent-read-index'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { renderJournalStatusItem } from '../../../agent-session-journal/projection/journal-public-read'

/** Where an agent read continues: rows through `sequence` are read, and the first `within`
 *  items of the next row (one row can name several). */
export type AgentReadJournalPosition = { cursor: AgentJournalCursor; within: number }

export type AgentReadJournalPage =
  | { ok: true; entries: AgentReadEntry[]; next: AgentReadJournalPosition; limited: boolean }
  | { ok: false }

/** One `orca agent read` page from a chat's journal, with work bounded by the page: a tail walks
 *  back over the journal's live agent-read entries, and a cursor read takes at most `limit + 1`
 *  rows and renders only the items they name. Neither renders the timeline, builds a snapshot or
 *  scans for turns. Entries use the history wire form (visibly shortened when too large), and a
 *  page stops at `limit` entries or the history page byte budget, whichever comes first.
 *  `waiting`: the live answer for a pending prompt. */
export function readAgentJournalPage(
  journal: AgentSessionJournal,
  request: { limit: number; after?: AgentReadJournalPosition },
  waiting: (itemId: string) => boolean
): AgentReadJournalPage {
  const { limit, after } = request
  const page = new PageBudget(limit)
  if (!after) {
    const newestFirst: AgentReadEntry[] = []
    let limited = false
    for (const item of journalAgentReadIndex(journal).newestFirst()) {
      const entry = entryOf(item, waiting)
      if (!entry) {
        continue
      }
      if (!page.admit(entry)) {
        limited = true
        break
      }
      newestFirst.push(entry)
    }
    return {
      ok: true,
      entries: newestFirst.toReversed(),
      next: { cursor: journal.cursor(), within: 0 },
      limited
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
  for (const row of rows) {
    const ids = journalRowItemIds(row, {
      canonical: journal.canonicalItemId,
      hasSubmission: (id) => journal.submission(id) !== undefined
    })
    const start = row.seq === after.cursor.sequence + 1 ? after.within : 0
    // One row's items appear once each, current content; `within` counts its raw positions.
    const seen = new Set(ids.slice(0, start))
    for (let index = start; index < ids.length; index++) {
      const id = ids[index]
      if (id === undefined || seen.has(id)) {
        continue
      }
      const item = renderJournalStatusItem(display, id)
      const entry = item && entryOf(item, waiting)
      if (!entry) {
        seen.add(id)
        continue
      }
      if (!page.admit(entry)) {
        // Stop before this item: the next read resumes at it.
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

/** The entry an item reads as, from its history wire form. */
function entryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean
): AgentReadEntry | null {
  const sent = agentJournalItemForWire(item).item
  const entry = agentChatEntryOf(sent, waiting)
  return entry && sent.shortened ? { ...entry, shortened: true } : entry
}

/** `limit` entries and the history page's byte budget; a first entry always fits, since wire
 *  forms are bounded well under the budget. */
class PageBudget {
  private count = 0
  private bytes = 0

  constructor(private readonly limit: number) {}

  admit(entry: AgentReadEntry): boolean {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (
      this.count >= this.limit ||
      (this.count > 0 && this.bytes + size > HISTORY_PAGE_CONTENT_BUDGET_BYTES)
    ) {
      return false
    }
    this.count++
    this.bytes += size
    return true
  }
}
