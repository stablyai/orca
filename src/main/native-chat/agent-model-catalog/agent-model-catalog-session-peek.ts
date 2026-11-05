import { onLiveAccount } from './agent-model-catalog-running-account'
import { withoutDefaultEfforts } from './agent-model-catalog-account-list'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export function agentModelCatalogSessionPeek(
  deps: AgentModelCatalogServiceDeps,
  binding: (params: AgentModelCatalogReadParams) => AgentModelCatalogBinding | undefined
) {
  return (sessionId: string, verifiedOnly?: boolean) => {
    const record = deps.getConversation(sessionId)
    const bound =
      record &&
      binding({
        agent: record.provider,
        sessionId,
        inSessionWorkspace: true,
        records: { record, scoped: onLiveAccount(deps, record), savedOnly: false }
      })
    const entry = bound ? deps.store.observation(bound.fingerprint) : null
    if (!bound || !entry || (verifiedOnly && !deps.store.verified(entry))) {
      return null
    }
    // The account's configured choice holds only where this chat's project cannot replace it.
    return (bound.keepEffort ?? bound.keepDefault)
      ? entry
      : {
          ...entry,
          configured: null,
          models: withoutDefaultEfforts(entry.models).map((model) =>
            bound.keepDefault ? model : { ...model, isDefault: false }
          )
        }
  }
}
