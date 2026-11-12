import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'

export function advisorySendRefusal(
  record: AgentSessionRecord | null,
  journal: AgentSessionJournal,
  operationId: string
) {
  return record?.advisoryPolicy &&
    journal.submissions().some((submission) => submission.clientMessageId !== operationId)
    ? unsupportedAdvisoryOperation()
    : null
}

export function advisoryOperationRefusal(record: AgentSessionRecord | null, method: string) {
  return record?.advisoryPolicy &&
    method !== 'agentSession.send' &&
    method !== 'agentSession.cancel'
    ? unsupportedAdvisoryOperation()
    : null
}

function unsupportedAdvisoryOperation() {
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'advisoryOperationUnsupported' },
    'This advisory session only accepts its original question and Stop.'
  )
}
