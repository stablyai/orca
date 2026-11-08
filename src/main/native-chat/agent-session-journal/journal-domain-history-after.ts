import type Database from '../../sqlite/sync-database'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionForwardHistory } from '../agent-session-wire/publication/history/agent-session-history-forward-page'
import type { HistoryReader } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { JournalReadSince } from './journal-store-contracts'
import type { JournalOutcomeReadRow } from './replay/journal-read-row'
import { findSequenceGap, resolveJournalResume } from './replay/journal-cursor'
import type { JournalDomainEventChanges } from './journal-domain-schema'
import type { JournalDomainHistoryHead } from './journal-domain-history-page'

/** Select one ordered event window, then current rows for only its identities, in the caller's snapshot. */
export function readJournalDomainForwardHistory(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
  latestTurn: AgentJournalRenderItem | null,
  readSnapshot: (ids: Set<string>) => AgentJournalSnapshot,
  reset: (
    reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ) => AgentSessionHistoryResult
): AgentSessionHistoryResult {
  return readAgentSessionForwardHistory(
    {
      readSince: (after, count) => readJournalDomainEvents(db, head, after, count),
      canonicalItemId: (itemId) => itemId,
      hasSubmission: () => false,
      reset
    },
    {
      sessionId: head.sessionId,
      cursor: head.cursor,
      items: latestTurn ? [latestTurn] : [],
      submissions: []
    },
    cursor,
    limit,
    reader,
    readSnapshot
  )
}

/** Retained events start after the pruned-through cursor; a missing sequence resets, never pages partially. */
function readJournalDomainEvents(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  cursor: AgentJournalCursor,
  limit = -1
): JournalReadSince {
  const resume = resolveJournalResume(
    {
      epoch: head.cursor.epoch,
      lastSequence: head.cursor.sequence,
      oldestSequence: head.retainedSequence + 1
    },
    cursor
  )
  if (!resume.ok) {
    return resume
  }
  const stored = db
    .prepare(`SELECT sequence, changes_json FROM journal_events
      WHERE session_id=? AND epoch=? AND sequence>? ORDER BY sequence LIMIT ?`)
    .all(head.sessionId, head.epoch, resume.afterSequence, limit)
  const complete = limit < 0 || stored.length < limit
  const sequences = stored.map((row) => Number(row.sequence))
  if (
    findSequenceGap(sequences, resume.afterSequence + 1) ||
    (complete && (sequences.at(-1) ?? resume.afterSequence) !== head.cursor.sequence)
  ) {
    return { ok: false, reset: 'journal_gap' }
  }
  const rows: JournalOutcomeReadRow[] = []
  for (const row of stored) {
    const changes = eventChanges(String(row.changes_json))
    if (!changes) {
      return { ok: false, reset: 'schema_unreadable' }
    }
    rows.push({
      kind: 'outcome',
      epoch: head.cursor.epoch,
      seq: Number(row.sequence),
      itemIds: [...changes.items.map((item) => item.itemId), ...(changes.removedItemIds ?? [])],
      submissionIds: changes.submissions
    })
  }
  return {
    ok: true,
    rows,
    through: complete ? head.cursor.sequence : sequences.at(-1)!,
    cursor: head.cursor
  }
}

function eventChanges(json: string): JournalDomainEventChanges | null {
  let changes: JournalDomainEventChanges
  try {
    changes = JSON.parse(json)
  } catch {
    return null
  }
  const ids = (value: unknown) =>
    Array.isArray(value) && value.every((id) => typeof id === 'string')
  return Array.isArray(changes?.items) &&
    changes.items.every((item) => typeof item?.itemId === 'string') &&
    ids(changes.submissions) &&
    (changes.removedItemIds === undefined || ids(changes.removedItemIds))
    ? changes
    : null
}
