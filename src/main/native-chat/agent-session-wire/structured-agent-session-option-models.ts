// Include unlisted current models without inferred capabilities, for both live and resting reads.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'

export type StructuredAgentSessionOptionProjection = {
  models: readonly AgentSessionModelOption[]
  options: Readonly<Record<string, string>>
}

export type StructuredAgentSessionLiveOptions = AgentSessionOptionsResult & {
  catalogListing?: AgentModelCatalogLiveListing
  /** The running CLI cannot change effort mid-chat, whatever its catalog lists. */
  effortFixed?: true
}

export type StructuredAgentSessionRestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'listedModelIds' | 'fastModeSupport' | 'current'
> & {
  inventory: AgentSessionModelCatalogResult
  fallback: AgentSessionOptionsResult['models']
}

export function structuredAgentSessionOptionModels<TModel extends AgentSessionModelOption>(
  catalog: readonly TModel[],
  current: string | undefined,
  row: (unlisted: AgentSessionModelOption) => TModel
): TModel[] {
  const models = [...catalog]
  if (current && !models.some((entry) => entry.id === current)) {
    models.push(
      row({ id: current, label: current, isDefault: false, efforts: [], effortsKnown: false })
    )
  }
  return models
}

/** Use seeds only for unknown listings; installed rows are authoritative. */
export function structuredAgentSessionCapabilityView(
  installed:
    | {
        models: readonly AgentSessionModelOption[]
        fastModeSupport?: AgentSessionOptionsResult['fastModeSupport']
      }
    | { origin: 'unknown' },
  current: string | undefined,
  fallback: readonly AgentSessionModelOption[] = [],
  restriction?: AgentSessionOptionsResult['fastModeSupport']
) {
  const inventory = 'models' in installed ? installed : { models: fallback }
  const models = structuredAgentSessionOptionModels(inventory.models, current, (row) => row)
  const support = models.find((row) => row.id === current)?.supportsFastMode
  return {
    models,
    fastModeSupport:
      restriction ??
      (support !== undefined
        ? { supported: support, ...(support ? {} : { reason: 'model-not-supported' as const }) }
        : inventory.fastModeSupport),
    listedServiceTiers: inventory.models.flatMap(
      (row) => row.serviceTiers?.map((tier) => tier.value) ?? []
    )
  }
}
