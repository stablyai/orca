import type { AgentSessionConversationOutlineEntry } from '../../../shared/agent-session/agent-session-conversation-outline'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'

/** Choose the global degradation before reading the admitted recent suffix. */
export function readJournalDomainOutline(scope: JournalSqlScope, budgetBytes: number) {
  const { db, prefix } = scope
  const totals = db
    .prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(member.entry_bytes + COALESCE(reply.reply_bytes,0)),0) AS with_reply,
    COALESCE(SUM(member.entry_bytes),0) AS full,
    COALESCE(SUM(member.short_bytes),0) AS short,
    COALESCE(SUM(member.empty_bytes),0) AS empty
    FROM journal_outline_members member INDEXED BY journal_outline_entries
    LEFT JOIN journal_outline_replies reply ON reply.session_id=member.session_id
      AND reply.epoch=member.epoch AND reply.turn_key=member.turn_key
    WHERE member.session_id=? AND member.epoch=? AND member.entry_json IS NOT NULL`)
    .get(...prefix)!
  const replies = Number(totals.with_reply) <= budgetBytes
  const variant =
    replies || Number(totals.full) <= budgetBytes
      ? 'entry'
      : Number(totals.short) <= budgetBytes
        ? 'short'
        : 'empty'
  const json = variant === 'entry' ? 'entry_json' : `${variant}_json`
  const bytes = variant === 'entry' ? 'entry_bytes' : `${variant}_bytes`
  const entries: AgentSessionConversationOutlineEntry[] = []
  let total = 0
  for (const row of db
    .prepare(`SELECT member.${json} AS entry_json,
    member.${bytes} + ${replies ? 'COALESCE(reply.reply_bytes,0)' : '0'} AS bytes,
    ${replies ? 'reply.reply' : 'NULL'} AS reply
    FROM journal_outline_members member INDEXED BY journal_outline_entries
    ${
      replies
        ? `LEFT JOIN journal_outline_replies reply ON reply.session_id=member.session_id
      AND reply.epoch=member.epoch AND reply.turn_key=member.turn_key`
        : ''
    }
    WHERE member.session_id=? AND member.epoch=? AND member.entry_json IS NOT NULL
    ORDER BY member.sequence DESC,member.sequence_index DESC,member.ordinal DESC`)
    .iterate(...prefix)) {
    const next = Number(row.bytes)
    if (total + next > budgetBytes) {
      break
    }
    total += next
    scope.examined(row)
    const entry = scope.decode<AgentSessionConversationOutlineEntry>(row.entry_json)
    entries.push(row.reply === null ? entry : { ...entry, reply: String(row.reply) })
  }
  entries.reverse()
  return {
    sessionId: scope.sessionId,
    cursor: journalDomainContextHead(db, scope),
    entries,
    omittedEntries: Number(totals.count) - entries.length
  }
}
