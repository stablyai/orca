import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'

export async function advisorySendRefusal(
  record: AgentSessionRecord | null,
  journal: AgentSessionJournal,
  operationId: string
) {
  if (!record?.advisoryPolicy && !record?.executionPolicy) {
    return null
  }
  const { results } = await journal.reads.input({
    kind: 'batch',
    reads: [{ kind: 'input-count' }, { kind: 'input-ordinal', clientMessageId: operationId }]
  })
  const count = results.find((result) => result.kind === 'input-count')?.count
  const ordinal = results.find((result) => result.kind === 'input-ordinal')?.ordinal
  return count === 0 || (count === 1 && ordinal === 0) ? null : unsupportedAdvisoryOperation()
}

export function advisoryOperationRefusal(record: AgentSessionRecord | null, method: string) {
  return (record?.advisoryPolicy || record?.executionPolicy) &&
    method !== 'agentSession.send' &&
    method !== 'agentSession.cancel'
    ? unsupportedAdvisoryOperation()
    : null
}

function unsupportedAdvisoryOperation() {
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'advisoryOperationUnsupported' },
    'This bounded session only accepts its original task and Stop.'
  )
}
