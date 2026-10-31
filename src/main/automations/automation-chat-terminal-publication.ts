import type { AutomationAttentionCorrelation } from '../runtime/automation-attention-correlations'
import { structuredAgentSessionRequestForItem } from '../../shared/structured-agent-session-latest-request'
import { isStructuredAgentSessionCommandTurn } from '../../shared/structured-agent-session-command-entry'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { JournalPublication } from '../native-chat/agent-session-wire/structured-agent-session-conversations'
export function observeAutomationTerminalPublication(
  attention: AutomationAttentionCorrelation | undefined,
  claim: { sessionId: string; messageId: string; submissionId?: string; turnItemId?: string },
  hint: JournalPublication,
  historical: boolean
): void {
  if (!attention) {
    return
  }
  const journal = hint.journal
  const scope = hint.scope
  const submission = journal?.submission(claim.submissionId ?? claim.messageId)
  const root = journal?.item(
    claim.turnItemId ?? agentJournalSubmissionKey(claim.submissionId ?? claim.messageId)
  )
  const turn = root ? readAgentJournalTurn(root.body) : null
  const commands =
    root &&
    isStructuredAgentSessionCommandTurn(
      turn,
      (id) => journal?.item(journal.canonicalItemId(id))?.body
    )
      ? new Set([root.itemId])
      : undefined
  const request = root ? structuredAgentSessionRequestForItem(root, submission, commands) : null
  const terminal =
    scope &&
    hint.source &&
    hint.cursor &&
    root &&
    submission &&
    request &&
    request.outcome &&
    request.turnState !== 'running'
      ? {
          source: hint.source,
          cursor: hint.cursor,
          root: root.itemId,
          submission: submission.clientMessageId,
          request,
          origin: {
            scope,
            sessionId: claim.sessionId,
            journalCursor: hint.cursor,
            cause: { kind: 'completion' as const, requestId: request.id }
          }
        }
      : undefined
  attention.observe(claim.sessionId, hint.source, hint.cursor, terminal, historical)
}
