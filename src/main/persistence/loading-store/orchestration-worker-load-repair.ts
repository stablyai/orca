import type { PersistedState } from '../../../shared/persisted-state-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeOrchestrationDefaultWorkerAgent,
  normalizeOrchestrationWorkerEfforts,
  normalizeOrchestrationWorkerModels,
  persistedOrchestrationWorkerPreferencesRepaired
} from '../../../shared/orchestration/workers/orchestration-worker-model-settings'

export type LoadedOrchestrationWorkerPreferences = {
  migratedOrchestrationDefaultWorkerAgent: GlobalSettings['orchestrationDefaultWorkerAgent']
  migratedOrchestrationWorkerModels: GlobalSettings['orchestrationWorkerModels']
  migratedOrchestrationWorkerEfforts: GlobalSettings['orchestrationWorkerEfforts']
}

/** Marks the profile for a save when the stored values differ from these;
 *  without it a load-time repair would be redone on every launch. */
export function prepareLoadedOrchestrationWorkerPreferences(
  settings: PersistedState['settings'] | undefined,
  markNeedsSave: () => void
): LoadedOrchestrationWorkerPreferences {
  const models = normalizeOrchestrationWorkerModels(settings?.orchestrationWorkerModels)
  const efforts = normalizeOrchestrationWorkerEfforts(settings?.orchestrationWorkerEfforts, models)
  const agent = normalizeOrchestrationDefaultWorkerAgent(settings?.orchestrationDefaultWorkerAgent)
  const repaired = persistedOrchestrationWorkerPreferencesRepaired(
    {
      orchestrationDefaultWorkerAgent: settings?.orchestrationDefaultWorkerAgent,
      orchestrationWorkerModels: settings?.orchestrationWorkerModels,
      orchestrationWorkerEfforts: settings?.orchestrationWorkerEfforts
    },
    { agent, models, efforts }
  )
  if (repaired) {
    markNeedsSave()
  }
  return {
    migratedOrchestrationDefaultWorkerAgent: agent,
    migratedOrchestrationWorkerModels: models,
    migratedOrchestrationWorkerEfforts: efforts
  }
}
