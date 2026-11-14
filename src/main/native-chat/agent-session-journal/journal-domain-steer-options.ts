import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionWorkPolicy } from '../agent-session-wire/observations/structured-agent-session-work-policy'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { journalDomainNewestTurn } from './journal-domain-input-populations'

export function journalDomainSteerOptions(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy,
  fence: number
) {
  if (!work.working()) {
    return { working: false }
  }
  const turn = journalDomainNewestTurn(context.scope)
  const running = turn?.state === 'running' && work.activeTurn() !== null
  const opener = running && turn.userItemId ? context.inputForItem(turn.userItemId) : undefined
  const candidates = running
    ? opener?.handedOverAt !== undefined
      ? [opener]
      : []
    : context
        .statusInputs()
        .filter((send) => send.handedOverAt !== undefined && work.owesSend(send))
  const pending = context
    .recoverableSubmissions()
    .some(
      (send) =>
        send.fence === fence && send.handedOverAt !== undefined && send.dispatchState === 'pending'
    )
  const active =
    candidates.length === 1
      ? candidates[0]
      : candidates.length === 0 && running && !pending
        ? latestChildOptions(context, fence)
        : undefined
  return { working: true, options: active?.options }
}

function latestChildOptions(context: JournalSqlStatusContext, fence: number) {
  const scope = context.scope
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    INDEXED BY journal_submission_latest_fence
    WHERE session_id=? AND epoch=? AND current=1 AND dispatch_fence=?
      AND json_type(payload_json,'$.handedOverAt') IS NOT NULL
      AND (dispatch_state!='rejected' OR json_type(payload_json,'$.answeredInTurn')='object')
    ORDER BY json_extract(payload_json,'$.handedOverAt') DESC,ordinal LIMIT 1`)
    .get(...scope.prefix, fence)
  return row ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json) : undefined
}
