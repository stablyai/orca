import { structuredMessageSteeringOptionsDiffer } from '../../../../shared/agent-session/options/codex-message-compiler'
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
  if (record.provider !== 'codex') {
    return false
  }
  const input = adapter?.captureMessageSteeringInputs?.({
    sessionId: record.sessionId,
    fence: child.fence,
    acquisitionGeneration: child.generation
  }) ?? { kind: 'codex-unavailable' }
  return structuredMessageSteeringOptionsDiffer(input, options)
}
