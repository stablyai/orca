import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionChildRan } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

const OPTION_ORDER = ['model', 'effort'] as const

/** A choice a message leaves unset runs what the child reports running. */
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

/** A different Codex model or effort needs a new turn: steer has no choice parameters. */
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
  const active = journal.submissions().find((submission) => {
    if (submission.handedOverAt === undefined) {
      return false
    }
    return agentJournalSubmissionKey(submission.clientMessageId) === turn.userItemId
  })
  return active
    ? !sameOptions(active.options, next.options, structuredAgentSessionChildRan(child))
    : true
}
