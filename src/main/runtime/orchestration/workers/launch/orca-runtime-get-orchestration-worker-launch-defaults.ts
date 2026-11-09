import { OrcaRuntimeWithRestoredHandlePaneStart } from './terminal/surface/restored-handle-pane-start'
import type { OrchestrationWorkerLaunchDefaults } from '../../shared/orchestration/workers/orchestration-worker-model-settings'

export abstract class OrcaRuntimeWithGetOrchestrationWorkerLaunchDefaults extends OrcaRuntimeWithRestoredHandlePaneStart {
  getOrchestrationWorkerLaunchDefaults(): OrchestrationWorkerLaunchDefaults {
    const settings = this.store?.getSettings()
    return {
      agent: settings?.orchestrationDefaultWorkerAgent ?? null,
      models: settings?.orchestrationWorkerModels ?? {},
      efforts: settings?.orchestrationWorkerEfforts ?? {}
    }
  }
}
