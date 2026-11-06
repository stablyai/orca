import type { PersistedState } from '../../../shared/persisted-state-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeOrchestrationDefaultWorkerAgent,
  normalizeOrchestrationWorkerEfforts,
  normalizeOrchestrationWorkerModels,
  persistedOrchestrationWorkerPreferencesRepaired
} from '../../../shared/orchestration-worker-model-settings'

export type LoadedOrchestrationWorkerPreferences = {
  migratedOrchestrationDefaultWorkerAgent: GlobalSettings['orchestrationDefaultWorkerAgent']
  migratedOrchestrationWorkerModels: GlobalSettings['orchestrationWorkerModels']
  migratedOrchestrationWorkerEfforts: GlobalSettings['orchestrationWorkerEfforts']
}

/** `repaired` reports that the stored values differ from these, so the profile owes a save;
 *  without it a load-time repair would be redone on every launch. */
export function prepareLoadedOrchestrationWorkerPreferences(
  settings: PersistedState['settings'] | undefined
): { preferences: LoadedOrchestrationWorkerPreferences; repaired: boolean } {
  const models = normalizeOrchestrationWorkerModels(settings?.orchestrationWorkerModels)
  const efforts = normalizeOrchestrationWorkerEfforts(settings?.orchestrationWorkerEfforts, models)
  const agent = normalizeOrchestrationDefaultWorkerAgent(settings?.orchestrationDefaultWorkerAgent)
  return {
    preferences: {
      migratedOrchestrationDefaultWorkerAgent: agent,
      migratedOrchestrationWorkerModels: models,
      migratedOrchestrationWorkerEfforts: efforts
    },
    repaired: persistedOrchestrationWorkerPreferencesRepaired(
      {
        orchestrationDefaultWorkerAgent: settings?.orchestrationDefaultWorkerAgent,
        orchestrationWorkerModels: settings?.orchestrationWorkerModels,
        orchestrationWorkerEfforts: settings?.orchestrationWorkerEfforts
      },
      { agent, models, efforts }
    )
  }
}
