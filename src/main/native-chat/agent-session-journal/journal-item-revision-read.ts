// An item as one write left it, read back from the epoch that wrote it: a replay answers with the
// revision a command was accepted at, never the item's latest fold. A retired epoch's rows are
// deleted with it, so a pointer into one reads nothing.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'

export type JournalItemRevisionPointer =
  | { epoch: string; sequence: number }
  | { epoch: string; itemId: string; revision: number }

export type JournalItemRevision = { itemId: string; revision: number; body: AgentJournalItemBody }

type RevisionSource = Pick<AgentSessionJournal, 'epoch' | 'readSince' | 'item' | 'canonicalItemId'>

const SCAN_PAGE = 256

export function readJournalItemRevision(
  journal: RevisionSource,
  at: JournalItemRevisionPointer
): JournalItemRevision | null {
  if (at.epoch !== journal.epoch) {
    return null
  }
  if ('sequence' in at) {
    const read = journal.readSince({ epoch: at.epoch, sequence: at.sequence - 1 }, 1)
    const row = read.ok ? read.rows[0] : undefined
    return row?.kind === 'item' && row.seq === at.sequence
      ? { itemId: row.itemId, revision: row.revision, body: row.body }
      : null
  }
  const target = journal.canonicalItemId(at.itemId)
  const folded = journal.item(target)
  if (folded?.revision === at.revision) {
    return { itemId: at.itemId, revision: at.revision, body: folded.body }
  }
  // A later revision replaced the fold's body; only the epoch's rows still hold this one.
  for (let after = 0; ;) {
    const read = journal.readSince({ epoch: at.epoch, sequence: after }, SCAN_PAGE)
    const rows = read.ok ? read.rows : []
    const row = rows.find(
      (entry) =>
        entry.kind === 'item' &&
        entry.revision === at.revision &&
        journal.canonicalItemId(entry.itemId) === target
    )
    if (row?.kind === 'item') {
      return { itemId: at.itemId, revision: at.revision, body: row.body }
    }
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) {
      return null
    }
    after = last.seq
  }
}
