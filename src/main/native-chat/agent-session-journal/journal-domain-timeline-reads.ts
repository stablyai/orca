import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalTimelineView } from './writing/journal-timeline-view'
import { isUnsettledJournalTimelineItem } from './writing/journal-timeline-view'
import {
  journalDomainLatestStop,
  journalDomainStopDecidesTurn
} from './journal-domain-item-normalization'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import { assertJournalDomainItemAuthority } from './journal-domain-item'

/** Typed named selections used only during the owning synchronous writer command. */
export function journalDomainTimelineReads(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  stopSettle?: JournalStopSettleFact,
  itemFence?: number
): JournalTimelineView {
  const prefix = [target.sessionId, target.epoch] as const
  const decode = (row: Record<string, unknown> | undefined): AgentJournalRenderItem | null =>
    row ? JSON.parse(String(row.payload_json)) : null
  const item = (key: string) =>
    decode(
      db
        .prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=COALESCE((SELECT item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
        .get(...prefix, ...prefix, key, key)
    )
  function* withKeyPrefix(keyPrefix: string) {
    let after: string | null = null
    const matching: Record<string, unknown>[] = []
    for (;;) {
      const rows = db
        .prepare(`SELECT item_id,payload_json,ordinal FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
        AND item_id>=? AND item_id<? ${after === null ? '' : 'AND item_id>?'} ORDER BY item_id LIMIT 64`)
        .all(...prefix, keyPrefix, `${keyPrefix}\uffff`, ...(after === null ? [] : [after]))
      matching.push(...rows)
      if (rows.length < 64) {
        break
      }
      after = String(rows.at(-1)!.item_id)
    }
    matching.sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    for (const row of matching) {
      yield decode(row)!
    }
  }
  function* unsettled(turnItemId: string | null) {
    let after: [number, string] | undefined
    for (;;) {
      const rows = db
        .prepare(`SELECT item_id,payload_json,ordinal FROM journal_items INDEXED BY journal_items_unsettled
        WHERE session_id=? AND epoch=? AND hidden=0 AND (lifecycle_state IN ('running','pending') OR live_work=1)
        ${after ? 'AND (ordinal,item_id)>(?,?)' : ''} ORDER BY ordinal,item_id LIMIT 128`)
        .all(...prefix, ...(after ?? []))
      for (const row of rows) {
        const value = decode(row)!
        if (
          (turnItemId === null ||
            (value.turnScope?.kind === 'turn' && value.turnScope.turnItemId === turnItemId)) &&
          isUnsettledJournalTimelineItem(value.body)
        ) {
          yield value
        }
      }
      if (rows.length < 128) {
        return
      }
      const last = rows.at(-1)!
      after = [Number(last.ordinal), String(last.item_id)]
    }
  }
  return {
    item,
    itemBody: (key) => item(key)?.body ?? null,
    hasVisibleProviderItemKey: (key) => {
      if (itemFence === undefined) {
        throw new Error('journal warning selection omitted its writer fence')
      }
      assertJournalDomainItemAuthority(db, target, itemFence)
      return Boolean(
        db
          .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
            AND legacy_provider_item_key IS NOT NULL AND legacy_provider_item_key=? LIMIT 1`)
          .get(...prefix, key)
      )
    },
    newestTurn: () =>
      decode(
        db
          .prepare(
            `SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND kind='turn' ORDER BY sequence DESC,ordinal DESC LIMIT 1`
          )
          .get(...prefix)
      ),
    withKeyPrefix,
    newestWithKeyPrefix: (keyPrefix) => {
      return decode(
        db
          .prepare(`SELECT payload_json FROM journal_items
        WHERE session_id=? AND epoch=? AND hidden=0 AND item_id>=? AND item_id<?
        ORDER BY sequence DESC,ordinal ASC LIMIT 1`)
          .get(...prefix, keyPrefix, `${keyPrefix}\uffff`)
      )
    },
    contextWindowHeld: () =>
      Boolean(
        db
          .prepare(
            `SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND context_window=1 LIMIT 1`
          )
          .get(...prefix)
      ),
    unsettled,
    stopDecidesTurn: (turnId, endedAt) =>
      journalDomainStopDecidesTurn(journalDomainLatestStop(db, target, stopSettle), turnId, endedAt)
  }
}
