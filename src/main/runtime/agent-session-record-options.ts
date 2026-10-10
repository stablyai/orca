import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type {
  AgentSessionModelChooser,
  AgentSessionOptionsReplacement
} from '../../shared/agent-session-options-replacement'

/** Who chose the model the new options hold: the replacement's word; else, while the record held a
 *  model, whoever chose that one, since a child's report of it or the start's replacement of a gone
 *  pick stands for the same choice; else nobody. */
function replacedModelChooser(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionModelChooser | undefined {
  if (!replacement.options.model) {
    return undefined
  }
  return replacement.modelChosenBy ?? (record.options?.model ? record.modelChosenBy : undefined)
}

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  const { lease } = record
  // At rest the host is the only writer: a pick is intent the next start replays.
  const atRest = lease.claimStatus === 'released' && lease.ownerProcess === null
  if (lease.runtimeFence !== replacement.fence || (lease.claimStatus !== 'live' && !atRest)) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  const { modelChosenBy: _previous, ...rest } = record
  const modelChosenBy = replacedModelChooser(record, replacement)
  return {
    ...rest,
    options: { ...replacement.options },
    ...(modelChosenBy ? { modelChosenBy } : {}),
    updatedAt: replacement.now
  }
}
