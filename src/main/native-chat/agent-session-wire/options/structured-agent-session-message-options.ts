import {
  structuredMessageSteeringOptionsDiffer,
  type StructuredMessageSteeringInputs
} from '../../../../shared/agent-session/options/codex-message-compiler'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalReads } from '../../agent-session-journal/journal-reads'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'

/** A different Codex control needs a new turn: steer has no choice parameters. */
export async function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: { reads: Pick<AgentSessionJournalReads, 'messageOptions'> },
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'captureMessageSteeringInputs'>
): Promise<boolean> {
  if (record?.provider !== 'codex') {
    return false
  }
  const options = await journal.reads.messageOptions(next.clientMessageId)
  if (!options.ordinaryMessage || !options.runningTurn) {
    return false
  }
  return codexTurnOptionsDiffer(record, next.options, child, adapter)
}

export function codexTurnOptionsDiffer(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'>,
  options: AgentSessionExecutionOptions | undefined,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'captureMessageSteeringInputs'>
): boolean {
  return structuredMessageSteeringOptionsDiffer(
    captureStructuredMessageSteeringInputs(record, child, adapter),
    options
  )
}

export function captureStructuredMessageSteeringInputs(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  child: StructuredAgentSessionProviderChild | null | undefined,
  adapter?: Pick<StructuredAgentSessionAdapter, 'captureMessageSteeringInputs'>
): StructuredMessageSteeringInputs {
  if (record?.provider !== 'codex') {
    return { kind: 'other' }
  }
  return (
    (child &&
      adapter?.captureMessageSteeringInputs?.({
        sessionId: record.sessionId,
        fence: child.fence,
        acquisitionGeneration: child.generation
      })) || { kind: 'codex-unavailable' }
  )
}
