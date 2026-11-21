import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

/** Passive verified configuration reads never launch a probe or substitute the current model. */
export async function readStructuredAgentSessionDefaultModel(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): Promise<AgentSessionOptionsResult['defaultModel']> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    return undefined
  }
  const listing = await deps.modelCatalog
    ?.read({
      agent: record.provider,
      sessionId,
      inSessionWorkspace: true,
      savedOnly: true,
      verifiedOnly: true,
      requireConfiguredDefault: true
    })
    .catch(() => null)
  const catalog =
    listing && listing.origin !== 'unknown' && !listing.listingInProgress && !listing.unavailable
      ? listing
      : undefined
  // A Default chat keeps what it resolved to; one that never ran follows the host's configuration.
  const id =
    record.defaultModelOptions?.model ??
    catalog?.defaultModelOptions?.model ??
    (catalog?.listingNamesConfiguredModel === true
      ? catalog.models.find((model) => model.isDefault)?.id
      : undefined)
  if (!id) {
    return undefined
  }
  const model = catalog?.models.find((model) => model.id === id)
  return {
    id,
    label: model?.label ?? id,
    ...(model?.description ? { description: model.description } : {})
  }
}
