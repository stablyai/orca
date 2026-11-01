import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadRecords } from './agent-model-catalog-running-account'

export function agentModelCatalogReadRecords(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
): AgentModelCatalogReadRecords | null {
  const record = params.sessionId ? deps.getConversation(params.sessionId) : undefined
  if (record && (record.provider !== params.agent || !deps.drivesRecord(record))) {
    return null
  }
  if (params.records !== undefined) {
    return params.records
  }
  return {
    record,
    scoped: record,
    savedOnly: !!params.savedOnly || !!(record && !deps.getRecord(record.sessionId))
  }
}

export function agentModelCatalogScopedRecord(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
) {
  const records = agentModelCatalogReadRecords(deps, params)
  const stored = params.sessionId ? deps.getConversation(params.sessionId) : undefined
  return records?.scoped && stored ? { ...stored, accountHome: records.scoped.accountHome } : stored
}

export function agentModelCatalogReleasedOwner(
  record: AgentSessionConversationView | undefined
): boolean {
  return (
    record?.ownerObservation.claimStatus === 'released' && !!record.ownerObservation.deathEvidence
  )
}
