import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogResolvedProbe
} from './agent-model-catalog-discovery'
import type { AgentModelCatalogListModels } from './agent-model-catalog-lister'
import { AgentModelCatalogListingStoppedError } from './agent-model-catalog-failures'

export function scopedAgentModelCatalogLister(input: {
  legacy?: boolean
  signal: AbortSignal
  resolved: AgentModelCatalogResolvedProbe | undefined
  probe: AgentModelCatalogProbe | undefined
  probeHome: AgentSessionAccountHome | null
  workspacePath: string | undefined
}): AgentModelCatalogListModels {
  const { resolved, probe, probeHome, workspacePath } = input
  return async (selectedModels, operation, publish) => {
    const signal = operation.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : input.signal
    try {
      // A slot that frees as the budget ends never starts the queued listing.
      if (operation.current?.() === false) {
        throw new AgentModelCatalogListingStoppedError('listing budget ended')
      }
      if (resolved) {
        return await resolved.run(signal, operation, selectedModels, publish)
      }
      if (!probe || !probeHome) {
        throw new AgentModelCatalogListingStoppedError('catalog scope unavailable')
      }
      return await probe(probeHome, {
        signal,
        workspacePath,
        ...(selectedModels ? { selectedModels } : {}),
        operation,
        publish
      })
    } catch (error) {
      throw input.signal.aborted
        ? new AgentModelCatalogListingStoppedError(String(error))
        : operation.signal?.aborted
          ? operation.signal.reason
          : error
    }
  }
}
