// The saved catalog rows a pick, a new chat's options and a turn's record are admitted against,
// and a pick's answer: the tier the chat's model runs; the record keeps the pick itself.

import { savedEffectiveServiceTier } from '../../../shared/structured-agent-session-effective-tier'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

/** The chat's saved catalog rows, read without starting discovery for its own folder, or for
 *  `workspacePath` where it has no record yet; none when nothing is saved. */
export async function savedAgentSessionCatalogModels(
  deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> },
  provider: string,
  sessionId: string,
  workspacePath?: string | null
): Promise<readonly AgentSessionModelOption[] | undefined> {
  const scope = workspacePath === undefined ? {} : { workspacePath }
  const listing = await deps.modelCatalog
    ?.read({ agent: provider, sessionId, savedOnly: true, ...scope })
    .catch(() => null)
  return listing && listing.origin !== 'unknown' ? listing.models : undefined
}

/** The committed options with the tier the chat's model runs, as the at-rest answer names it. */
export function structuredAgentSessionPickReply(
  options: Readonly<Record<string, string>>,
  models: readonly AgentSessionModelOption[] | undefined
): Record<string, string> {
  const serviceTier = savedEffectiveServiceTier(options, models ?? []) ?? options.serviceTier
  return serviceTier ? { ...options, serviceTier } : { ...options }
}
