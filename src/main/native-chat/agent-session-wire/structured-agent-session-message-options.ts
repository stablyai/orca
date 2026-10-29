import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

const OPTION_ORDER = ['model', 'effort', 'serviceTier', 'personality'] as const

/** A different Codex control needs a new turn: steer has no choice parameters. */
export function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'itemBody'>,
  next: AgentJournalSubmission,
  child: StructuredAgentSessionProviderChild,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
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
  const applied = adapter?.readAppliedInputOptions?.({
    sessionId: record.sessionId,
    fence: child.fence,
    acquisitionGeneration: child.generation,
    next: next.options
  })
  if (!applied) {
    return (
      next.options === undefined || Object.values(next.options).some((value) => value !== undefined)
    )
  }
  return OPTION_ORDER.some(
    (key) => applied.next[key] !== undefined && applied.next[key] !== applied.active[key]
  )
}
