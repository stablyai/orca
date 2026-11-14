import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { latestStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { newestJournalDomainTurnOrClear } from './journal-sql-item-reads'
import type {
  JournalOutgrownChild,
  JournalOutgrownChildRead,
  JournalRestartProgress
} from './journal-lifecycle-reads'

export type JournalSqlLifecycleRead =
  | { kind: 'latest-prompt' }
  | { kind: 'restart-progress'; cursor: AgentJournalCursor }
  | { kind: 'outgrown-child'; input: JournalOutgrownChildRead }

export type JournalSqlLifecycleReadResult =
  | { kind: 'latest-prompt'; prompt: string }
  | { kind: 'restart-progress'; progress: JournalRestartProgress }
  | { kind: 'outgrown-child'; child: JournalOutgrownChild }

/** Runs synchronously in the caller's existing reader snapshot. */
export function readJournalDomainLifecycle(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  operation: JournalSqlLifecycleRead
): JournalSqlLifecycleReadResult {
  const prefix = [target.sessionId, target.epoch] as const
  if (operation.kind === 'latest-prompt') {
    const row = db
      .prepare(`SELECT payload_json FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND prompt=1
      ORDER BY sequence DESC,ordinal DESC LIMIT 1`)
      .get(...prefix)
    return {
      kind: 'latest-prompt',
      prompt: row ? latestStructuredAgentSessionPrompt([JSON.parse(String(row.payload_json))]) : ''
    }
  }
  if (operation.kind === 'restart-progress') {
    return {
      kind: 'restart-progress',
      progress: {
        epoch: journalDomainContextHead(db, target).epoch,
        acceptedInputs: db
          .prepare(`SELECT payload_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND current=1 AND accepted_sequence>?
        ORDER BY accepted_sequence,ordinal`)
          .all(...prefix, operation.cursor.sequence)
          .map((row) => JSON.parse(String(row.payload_json)))
      }
    }
  }
  const { fence, nextClientMessageId } = operation.input
  const signedOut = Boolean(
    db
      .prepare(`SELECT 1 FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND signed_out=1 AND dispatch_fence=? LIMIT 1`)
      .get(...prefix, fence) ||
    db
      .prepare(`SELECT 1 FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND signed_out=1
        AND COALESCE(execution_owner,owner_fence)=? LIMIT 1`)
      .get(...prefix, fence)
  )
  const next =
    nextClientMessageId === undefined
      ? undefined
      : db
          .prepare(`SELECT payload_json
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
          .get(...prefix, agentJournalSubmissionKey(nextClientMessageId))
  const nextItem: AgentJournalRenderItem | null = next
    ? JSON.parse(String(next.payload_json))
    : null
  const body = nextItem?.body
  return {
    kind: 'outgrown-child',
    child: {
      signedOut,
      newestTurnCompletedAt: readAgentJournalTurn(newestJournalDomainTurnOrClear(db, prefix)?.body)
        ?.completedAt,
      nextMessage: body?.kind === 'message' ? body : null
    }
  }
}
