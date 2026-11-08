import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalReads } from '../../agent-session-journal/journal-reads'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/agent-session-execution-options'

const OPTION_ORDER = ['model', 'effort', 'serviceTier', 'personality', 'interactionMode'] as const

/** A different Codex control needs a new turn: steer has no choice parameters. */
export async function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: { reads: Pick<AgentSessionJournalReads, 'messageOptions'> },
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
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
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
): boolean {
  if (record.provider !== 'codex') {
    return false
  }
  const applied = adapter?.readAppliedInputOptions?.({
    sessionId: record.sessionId,
    fence: child.fence,
    acquisitionGeneration: child.generation,
    next: options
  })
  if (!applied) {
    return options === undefined || Object.values(options).some((value) => value !== undefined)
  }
  return OPTION_ORDER.some(
    (key) => applied.next[key] !== undefined && applied.next[key] !== applied.active[key]
  )
}
