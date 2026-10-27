import { structuredAgentSessionCapabilityView } from './structured-agent-session-option-models'
import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

/** Read saved folder-scoped models without discovery; use workspacePath before record creation. */
export async function savedAgentSessionCatalogModels(
  deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> },
  provider: string,
  sessionId: string,
  workspacePath?: string | null,
  verifiedOnly = true
): Promise<readonly AgentSessionModelOption[] | undefined> {
  const scope = workspacePath === undefined ? {} : { workspacePath }
  const listing = await deps.modelCatalog
    ?.read({ agent: provider, sessionId, savedOnly: true, verifiedOnly, ...scope })
    .catch(() => null)
  return listing && listing.origin !== 'unknown'
    ? structuredAgentSessionCapabilityView(listing, undefined).models
    : undefined
}

/** Report effective model tier while retaining the stored pick itself. */
export function structuredAgentSessionPickReply(
  options: Readonly<Record<string, string>>,
  models: readonly AgentSessionModelOption[] | undefined
): Record<string, string> {
  const serviceTier = savedEffectiveServiceTier(options, models ?? []) ?? options.serviceTier
  return serviceTier ? { ...options, serviceTier } : { ...options }
}
