import type { JournalSqlScope } from './journal-sql-scope'

/** Accepted opener identity is current admission plus current presentation, never an item cache. */
export function readJournalDomainAcceptedSendUnopened(scope: JournalSqlScope): boolean {
  const latest = scope.db
    .prepare(`SELECT item.item_id,item.sequence,attempt.ordinal
    FROM journal_submission_attempts attempt JOIN journal_items item
      ON item.session_id=attempt.session_id AND item.epoch=attempt.epoch AND item.item_id=attempt.item_id
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1 AND attempt.dispatch_state='accepted'
      AND item.hidden=0 AND item.root=1 AND (item.turn_scope_kind IS NULL OR item.turn_scope_kind<>'turn')
    ORDER BY item.sequence DESC,attempt.ordinal DESC LIMIT 1`)
    .get(...scope.prefix)
  if (!latest) {
    return false
  }
  scope.examined(latest)
  const itemId = String(latest.item_id)
  const opened = scope.db.prepare(`SELECT 1 FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND opener_item_id=? LIMIT 1`)
  const native = opened.get(...scope.prefix, itemId)
  if (native) {
    scope.examined(native)
    return false
  }
  let after = ''
  for (;;) {
    const aliases = scope.db
      .prepare(`SELECT provider_item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND item_id=? AND provider_item_id>?
      ORDER BY provider_item_id LIMIT 128`)
      .all(...scope.prefix, itemId, after)
    for (const alias of aliases) {
      scope.examined(alias)
      const turn = opened.get(...scope.prefix, String(alias.provider_item_id))
      if (turn) {
        scope.examined(turn)
        return false
      }
    }
    const last = aliases.at(-1)
    if (aliases.length < 128 || !last) {
      return true
    }
    after = String(last.provider_item_id)
  }
}
