import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import type {
  AgentModelCatalogListing,
  AgentModelCatalogConfiguredDefault,
  AgentModelCatalogConfiguredChoice
} from './agent-model-catalog-entry'

/** Newer listings own membership/menus; configured facts then discovery/live determine defaults. */
export function mergedAgentModelCatalogModels(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  configured: AgentModelCatalogConfiguredDefault | null
): AgentSessionModelOption[] {
  const liveIsNewer = live !== null && (discovered === null || live.at >= discovered.at)
  const newer = liveIsNewer ? live : discovered
  const older = liveIsNewer ? discovered : live
  return (newer?.models ?? []).map((model) => {
    const listed = discovered?.models.find((entry) => entry.id === model.id)
    const reported = live?.models.find((entry) => entry.id === model.id)
    const olderModel = older?.models.find((entry) => entry.id === model.id)
    const olderEfforts = olderModel?.efforts ?? []
    const runsConfigured =
      configured?.modelId === model.id || configured?.sameModelIds?.includes(model.id) === true
    const configuredEffort = runsConfigured ? configured?.effort : undefined
    const offersConfigured = (menu: AgentSessionModelOption['efforts']): boolean =>
      menu.some((choice) => choice.value === configuredEffort)
    // Coarser probe menus must not discard a chat-confirmed effort unless a newer chat menu does.
    const keepsChatMenu =
      older === live && !offersConfigured(model.efforts) && offersConfigured(olderEfforts)
    const { efforts, effortsKnown } =
      olderModel && model.effortsKnown !== olderModel.effortsKnown
        ? model.effortsKnown === false
          ? olderModel
          : model
        : model.efforts.length > 0 && !keepsChatMenu
          ? model
          : (olderModel ?? model)
    const defaultEffort = [configuredEffort, listed?.defaultEffort, reported?.defaultEffort].find(
      (effort) => effort !== undefined && efforts.some((choice) => choice.value === effort)
    )
    const observation = [model, olderModel].find(
      (row) => row?.declaredDefaultEffort !== undefined
    )?.declaredDefaultEffort
    const {
      defaultEffort: _own,
      declaredDefaultEffort: _declaration,
      effortsKnown: _known,
      ...rest
    } = model
    return {
      ...rest,
      // Efforts stay unknown only when neither listing knows this model's menu.
      ...(effortsKnown === false ? { effortsKnown } : {}),
      // Without discovery/configuration, live flags are the only available default evidence.
      isDefault: configured
        ? model.id === configured.modelId
        : discovered
          ? listed?.isDefault === true
          : model.isDefault,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(observation !== undefined
        ? {
            declaredDefaultEffort:
              observation !== null && efforts.some((choice) => choice.value === observation)
                ? observation
                : null
          }
        : {})
    }
  })
}

/** Only a fresh validated configured observation supplies declaration evidence. */
export function configuredDeclarationModels(
  models: AgentSessionModelOption[],
  choice: AgentModelCatalogConfiguredChoice | null | undefined
): AgentSessionModelOption[] {
  if (typeof choice?.effort !== 'string') {
    return models
  }
  let changed = false
  const observed = models.map((row) => {
    if (
      row.id !== choice.modelId &&
      row.resolvedModel !== choice.modelId &&
      !choice.sameModelIds?.includes(row.id)
    ) {
      return row
    }
    const declaredDefaultEffort =
      row.effortsKnown !== false && row.efforts.some((effort) => effort.value === choice.effort)
        ? choice.effort
        : null
    if (row.declaredDefaultEffort === declaredDefaultEffort) {
      return row
    }
    changed = true
    return { ...row, declaredDefaultEffort }
  })
  return changed ? observed : models
}
