import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionChildRan } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

const OPTION_ORDER = ['model', 'effort'] as const

/** Unset message choices inherit child execution values. */
function sameOptions(
  a: AgentSessionExecutionOptions | undefined,
  b: AgentSessionExecutionOptions | undefined,
  ran: Readonly<Record<string, string>> | undefined
): boolean {
  if ((a === undefined) !== (b === undefined)) {
    return false
  }
  return OPTION_ORDER.every((key) => (a?.[key] ?? ran?.[key]) === (b?.[key] ?? ran?.[key]))
}

/** Codex steer has no model/effort parameters; changed choices need a new turn. */
export function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'submissions' | 'itemBody'>,
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild
): boolean {
  if (record?.provider !== 'codex') {
    return false
  }
  const body = journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  if (body?.kind !== 'message' || body.command) {
    return false
  }
  const turn = journal.newestTurn()
  if (turn?.state !== 'running') {
    return false
  }
  const handed = journal.submissions().filter((submission) => submission.handedOverAt !== undefined)
  const opener = handed.find(
    (submission) => agentJournalSubmissionKey(submission.clientMessageId) === turn.userItemId
  )
  const onChild = handed.filter((submission) => submission.fence === child.fence)
  // An unechoed send may own this turn; joining it first would reorder the thread.
  if (!opener && onChild.some((submission) => submission.dispatchState === 'pending')) {
    return true
  }
  const active =
    opener ??
    // Goal continuations have no opener and run on this child's last turn/start choices.
    onChild
      // A send rejected after its turn opened still set the thread's choices.
      .filter((submission) => submission.dispatchState !== 'rejected' || submission.answeredInTurn)
      .reduce<AgentJournalSubmission | undefined>(
        (newest, submission) =>
          newest && (newest.handedOverAt ?? 0) > (submission.handedOverAt ?? 0)
            ? newest
            : submission,
        undefined
      )
  const ran = structuredAgentSessionChildRan(child)
  if (active) {
    return !sameOptions(active.options, next.options, ran)
  }
  return OPTION_ORDER.some(
    (key) => next.options?.[key] !== undefined && next.options[key] !== ran?.[key]
  )
}
