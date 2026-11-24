import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainNamedSubagentIds } from './journal-domain-history-metadata'

type HistoryTarget = { sessionId: string; epoch: string }

/** Ordinary content revisions keep the same memberships without rewriting their rows. */
export function writeJournalDomainItemNames(
  db: Database.Database,
  target: HistoryTarget,
  item: AgentJournalRenderItem,
  placement: { ordinal: number; hidden: boolean },
  namedIds: readonly string[],
  previous?: { item: AgentJournalRenderItem; ordinal: number; hidden: boolean }
): void {
  const names = new Set(namedIds)
  const priorNames = new Set(previous ? journalDomainNamedSubagentIds(previous.item) : [])
  if (
    names.size === priorNames.size &&
    [...names].every((id) => priorNames.has(id)) &&
    (!previous ||
      (previous.item.sequence === item.sequence &&
        (previous.item.sequenceIndex ?? 0) === (item.sequenceIndex ?? 0) &&
        previous.ordinal === placement.ordinal &&
        previous.hidden === placement.hidden))
  ) {
    return
  }
  const key = [target.sessionId, target.epoch, item.itemId] as const
  db.prepare(
    'DELETE FROM journal_item_subagent_names WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(...key)
  const insert = db.prepare(`INSERT OR IGNORE INTO journal_item_subagent_names(
      session_id,epoch,subagent_id,item_id,sequence,sequence_index,ordinal,hidden)
    VALUES(?,?,?,?,?,?,?,?)`)
  for (const subagentId of names) {
    insert.run(
      target.sessionId,
      target.epoch,
      subagentId,
      item.itemId,
      item.sequence,
      item.sequenceIndex ?? 0,
      placement.ordinal,
      Number(placement.hidden)
    )
  }
}
