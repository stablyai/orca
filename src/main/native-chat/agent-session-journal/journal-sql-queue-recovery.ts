import type { JournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import { readJournalLegacyCards } from './queued-messages/journal-queue-import'
import { legacyQueuePositions } from './queued-messages/legacy-queue-positions'
import { journalUnsentSendBatch } from './queued-messages/journal-unsent-send-hold'
import { staleSubagentRosterRevisions } from './item-lifecycle/journal-subagent-liveness'
import { memoryJournalMap } from './journal-memory-collections'
import type { JournalSqlScope } from './journal-sql-scope'
import type Database from '../../sqlite/sync-database'

export function journalSqlQueueRecoverySchema(): string {
  return `CREATE TABLE IF NOT EXISTS journal_proj_recovery_positions (
    session_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position REAL NOT NULL,
    PRIMARY KEY (session_id, epoch, message_id)
  ) WITHOUT ROWID;`
}

/** Run after exporting the restored state: these opening-only decoder changes are not saved. */
export function stageJournalSqlQueueRecovery(
  source: Database.Database,
  staging: Database.Database,
  state: JournalReducerState
): void {
  const order = journalInputOrder(state)
  if (!order.legacy) {
    return
  }
  const overlays = readJournalLegacyCards(source, state)
  // The first open-time write introduces overlays before recovery plans their ranks.
  if (
    overlays.length > 0 ||
    [...memoryJournalMap(state.items).values()].some(
      (item) => staleSubagentRosterRevisions([item]).length > 0
    )
  ) {
    order.legacy.lineage.observe(state.lastSequence + 1)
    order.introduceOverlays(state)
  }
  order.markOpeningRecovery()
  const batch = journalUnsentSendBatch(
    { inputOrder: order, itemBody: (id) => state.items.get(id)?.body ?? null },
    { hold: { cause: 'hostRestarted' } }
  )
  if (batch.length === 0) {
    return
  }
  const overlay = new Map(overlays.map((card) => [card.messageId, card]))
  const positions = legacyQueuePositions(
    {
      state,
      order,
      cards: order.cards.list(),
      get: (id) => state.queue.cards.get(id) ?? overlay.get(id)
    },
    batch,
    false
  )
  const insert = staging.prepare('INSERT INTO journal_proj_recovery_positions VALUES (?,?,?,?)')
  for (const [id, position] of positions.placed) {
    insert.run(state.sessionId, state.epoch, id, position)
  }
}

/** Only the first successful open consumes these conversion-derived ranks. */
export function readJournalSqlQueueRecovery(
  scope: JournalSqlScope,
  get: (id: string) => { position: number } | null
): ReturnType<typeof legacyQueuePositions> | undefined {
  const rows = scope.db
    .prepare(
      'SELECT message_id,position FROM journal_proj_recovery_positions WHERE session_id=? AND epoch=?'
    )
    .all(...scope.prefix)
  if (rows.length === 0) {
    return undefined
  }
  const placed = new Map(rows.map((row) => [String(row.message_id), Number(row.position)]))
  return {
    placed,
    moves: [...placed].flatMap(([messageId, position]) => {
      const card = get(messageId)
      return card && card.position !== position ? [{ messageId, position }] : []
    })
  }
}
