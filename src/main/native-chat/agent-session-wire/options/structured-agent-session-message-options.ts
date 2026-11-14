import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/agent-session-execution-options'

const OPTION_ORDER = ['model', 'effort', 'serviceTier', 'personality', 'interactionMode'] as const

/** Codex and Trae steers carry no option changes; different controls need a new turn. */
export function waitsForProviderTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'itemBody'>,
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
): boolean {
  if (record?.provider !== 'codex' && record?.provider !== 'trae') {
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
  return providerTurnOptionsDiffer(record, next.options, child, adapter)
}

export function providerTurnOptionsDiffer(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'>,
  options: AgentSessionExecutionOptions | undefined,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
): boolean {
  if (record.provider !== 'codex' && record.provider !== 'trae') {
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
