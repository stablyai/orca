import {
  projectAgentSessionConversationOutline,
  type AgentSessionConversationOutline
} from '../../../shared/agent-session/agent-session-conversation-outline'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { boundJournalConversationOutline } from './journal-outline-budget'
import type { JournalOutlineSource } from './journal-domain-outline-source'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalOutlineCache = {
  sessionId: string
  epoch: string
  sequence: number
  revision: number
  budgetBytes: number
  json: string
}

/** Cold reads reconstruct compact facts; ordinary writes never regroup the chat. */
export function readJournalDomainOutline(scope: JournalSqlScope, budgetBytes: number) {
  const { db, prefix } = scope
  const head = db
    .prepare(
      'SELECT last_sequence,submissions_revision FROM journal_chat_state WHERE session_id=? AND epoch=?'
    )
    .get(...prefix)!
  const sequence = Number(head.last_sequence)
  const revision = Number(head.submissions_revision)
  const stored = db
    .prepare(`SELECT outline_json FROM journal_outline_cache
    WHERE session_id=? AND epoch=? AND source_sequence=? AND source_revision=? AND budget_bytes=?`)
    .get(...prefix, sequence, revision, budgetBytes)
  if (stored) {
    try {
      return { outline: scope.decode<AgentSessionConversationOutline>(stored.outline_json) }
    } catch {
      // A damaged cache can be reconstructed from the current compact source.
    }
  }
  const sources = db
    .prepare(`SELECT outline_source_json FROM journal_items
    INDEXED BY journal_items_visible_position WHERE session_id=? AND epoch=? AND hidden=0
    AND outline_source_json IS NOT NULL ORDER BY sequence,sequence_index,ordinal`)
    .all(...prefix)
    .map((row) => scope.decode<JournalOutlineSource>(row.outline_source_json))
  const byId = new Map(sources.map((source) => [source.item.itemId, source]))
  const submissions = db
    .prepare(`SELECT outline_json FROM journal_submission_attempts
    INDEXED BY journal_submission_ordinal WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal`)
    .all(...prefix)
    .map((row) => scope.decode<AgentJournalSubmission>(row.outline_json))
  const entries = projectAgentSessionConversationOutline(
    sources.map((source) => source.item),
    submissions,
    (messages, keys) => {
      const replies = new Map<string, string>()
      for (let index = messages.length - 1; index >= 0; index--) {
        const key = keys[index]
        const reply = byId.get(messages[index].id)?.reply
        if (key !== undefined && reply && !replies.has(key)) {
          replies.set(key, reply)
        }
      }
      return replies
    },
    {
      projectItems: (items) =>
        items.flatMap((item) => {
          const message = byId.get(item.itemId)?.message
          return message ? [message] : []
        }),
      userPreview: (message) => byId.get(message.id)!.preview!
    }
  )
  const outline = boundJournalConversationOutline(
    { sessionId: scope.sessionId, cursor: journalDomainContextHead(db, scope) },
    entries,
    budgetBytes
  )
  return {
    outline,
    cache: {
      sessionId: scope.sessionId,
      epoch: scope.epoch,
      sequence,
      revision,
      budgetBytes,
      json: JSON.stringify(outline)
    } satisfies JournalOutlineCache
  }
}

/** Cache admission is optional and rechecks the reader's exact source inside the sole writer. */
export function saveJournalDomainOutlineCache(
  db: Database.Database,
  cache: JournalOutlineCache
): boolean {
  const prefix = [cache.sessionId, cache.epoch] as const
  if (
    db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_unsettled
    WHERE session_id=? AND epoch=? AND hidden=0
    AND (lifecycle_state IN ('running','pending') OR live_work=1) LIMIT 1`)
      .get(...prefix) ||
    db
      .prepare(`SELECT 1 FROM journal_submission_attempts INDEXED BY journal_submission_sending
    WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='pending' LIMIT 1`)
      .get(...prefix)
  ) {
    return false
  }
  return (
    Number(
      db
        .prepare(`INSERT INTO journal_outline_cache
    (session_id,epoch,source_sequence,source_revision,budget_bytes,outline_json)
    SELECT session_id,epoch,last_sequence,submissions_revision,?,? FROM journal_chat_state
    WHERE session_id=? AND epoch=? AND last_sequence=? AND submissions_revision=?
    ON CONFLICT(session_id,epoch) DO UPDATE SET source_sequence=excluded.source_sequence,
    source_revision=excluded.source_revision,budget_bytes=excluded.budget_bytes,outline_json=excluded.outline_json`)
        .run(cache.budgetBytes, cache.json, ...prefix, cache.sequence, cache.revision).changes
    ) > 0
  )
}
