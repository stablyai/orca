import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentReadEntry } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { compareAgentJournalItems } from '../../../../../shared/agent-session/journal/agent-session-journal-position'
import { agentChatEntryOf } from '../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { findSequenceGap } from '../../../agent-session-journal/replay/journal-cursor'
import { journalRowRawSlots } from '../../../agent-session-journal/replay/journal-row-item-ids'
import type { JournalReadRow } from '../../../agent-session-journal/replay/journal-read-row'
import { journalAgentReadIndex } from '../../../agent-session-journal/projection/journal-agent-read-index'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { renderJournalStatusItem } from '../../../agent-session-journal/projection/journal-public-read'
import {
  agentReadPartialRowBytes,
  agentReadRowFingerprint,
  EmittedSlots,
  type AgentReadPartialRow
} from './agent-read-row-progress'

/** Where an agent read continues: rows through `sequence` are read, and `partial` names the next
 *  row when part of it was (one row can name several items). */
export type AgentReadJournalPosition = { cursor: AgentJournalCursor; partial?: AgentReadPartialRow }

/** Cursor bytes the history envelope reserve carries; a row needing more takes the rest from its
 *  page's content budget. */
const CURSOR_ALLOWANCE_BYTES = 32 * 1024

export type AgentReadJournalPage =
  | { ok: true; entries: AgentReadEntry[]; next: AgentReadJournalPosition; limited: boolean }
  | { ok: false }

/** One `orca agent read` page from a chat's journal, with work bounded by the page: a tail walks
 *  back over the journal's live agent-read entries, and a cursor read takes at most `limit + 1`
 *  rows and renders only the items they name. Neither renders the timeline, builds a snapshot or
 *  scans for turns. Entries use the history wire form (visibly shortened when too large, or the
 *  history's too-large marker when even that can't fit a page), and a page stops at `limit`
 *  entries or the history page byte budget, whichever comes first.
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
      next: { cursor: journal.cursor() },
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
    (after.partial && since.rows[0]?.seq !== after.partial.row)
  ) {
    return { ok: false }
  }
  const rows = since.rows.slice(0, limit)
  const display = journal.queuedMessages.displayState()
  const entries: AgentReadEntry[] = []
  let consumed = after.cursor.sequence
  for (const row of rows) {
    const read = readRow(
      journal,
      display,
      row,
      row.seq === after.partial?.row ? after.partial : null
    )
    if (!read) {
      return { ok: false }
    }
    for (const group of read.groups) {
      const entry = entryOf(group.item, waiting, read.reserve)
      if (!entry) {
        continue
      }
      if (!page.admit(entry, read.reserve)) {
        // Stop before this item, with what this row has already represented.
        return {
          ok: true,
          entries,
          next: {
            cursor: { epoch: after.cursor.epoch, sequence: consumed },
            partial: read.partial()
          },
          limited: true
        }
      }
      read.represent(group)
      entries.push(entry)
    }
    consumed = row.seq
  }
  const more = since.rows.length > rows.length
  return {
    ok: true,
    entries,
    next: { cursor: { epoch: after.cursor.epoch, sequence: more ? consumed : since.through } },
    limited: more
  }
}

type RowGroup = { item: AgentJournalRenderItem; slots: number[] }

/** One row's current unrepresented items in presented order, over its raw slots: a canonical
 *  item with any represented slot is represented, wherever it now sorts, and hidden or missing
 *  items are left unrepresented. Null when `partial` was cut from a different row. */
function readRow(
  journal: AgentSessionJournal,
  display: Parameters<typeof renderJournalStatusItem>[0],
  row: JournalReadRow,
  partial: AgentReadPartialRow | null
) {
  const slots = journalRowRawSlots(row)
  const fingerprint = agentReadRowFingerprint(row.kind, slots)
  const emitted = partial
    ? partial.count === slots.length && partial.fingerprint === fingerprint
      ? EmittedSlots.decode(partial.emitted, slots.length)
      : null
    : EmittedSlots.none(slots.length)
  if (!emitted) {
    return null
  }
  const bySlot = new Map<string, number[]>()
  slots.forEach((slot, index) => {
    const id = journal.canonicalItemId(slot)
    bySlot.set(id, [...(bySlot.get(id) ?? []), index])
  })
  const groups: RowGroup[] = []
  for (const [id, indexes] of bySlot) {
    if (indexes.some((index) => emitted.has(index))) {
      indexes.forEach((index) => emitted.add(index))
      continue
    }
    const item = renderJournalStatusItem(display, id)
    if (item) {
      groups.push({ item, slots: indexes })
    }
  }
  groups.sort(
    (a, b) =>
      compareAgentJournalItems(a.item, b.item) ||
      (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0)
  )
  return {
    groups,
    reserve: Math.max(0, agentReadPartialRowBytes(slots.length) - CURSOR_ALLOWANCE_BYTES),
    represent: (group: RowGroup) => group.slots.forEach((index) => emitted.add(index)),
    partial: (): AgentReadPartialRow => ({
      row: row.seq,
      count: slots.length,
      fingerprint,
      emitted: emitted.encode()
    })
  }
}

/** The entry an item reads as, from its history wire form. One no page could carry reads as the
 *  history's own too-large marker, said by Orca rather than the agent. */
function entryOf(
  item: AgentJournalRenderItem,
  waiting: (itemId: string) => boolean,
  reserve = 0
): AgentReadEntry | null {
  const budget = HISTORY_PAGE_CONTENT_BUDGET_BYTES - reserve
  const sent = agentJournalItemForWire(item)
  const entry = agentChatEntryOf(sent.item, waiting)
  if (!entry) {
    return null
  }
  const shown: AgentReadEntry = sent.item.shortened ? { ...entry, shortened: true } : entry
  if (sent.bytes <= budget && entryBytes(shown) <= budget) {
    return shown
  }
  const marker = oversizedHistoryItem(item).body
  return {
    kind: 'message',
    role: 'system',
    text: marker.kind === 'status' ? String(marker.text) : ''
  }
}

/** An entry's serialized size, with its separator in the page's entries array. */
const entryBytes = (entry: AgentReadEntry) => Buffer.byteLength(JSON.stringify(entry)) + 1

/** `limit` entries within the history page's byte budget, less any cursor `reserve`. */
class PageBudget {
  private count = 0
  private bytes = 0

  constructor(private readonly limit: number) {}

  admit(entry: AgentReadEntry, reserve = 0): boolean {
    const size = entryBytes(entry)
    if (
      this.count >= this.limit ||
      this.bytes + size + reserve > HISTORY_PAGE_CONTENT_BUDGET_BYTES
    ) {
      return false
    }
    this.count++
    this.bytes += size
    return true
  }
}
