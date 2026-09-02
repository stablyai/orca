import { OrcaRuntimeWithGetTerminalInteractiveWait } from './orca-runtime-get-terminal-interactive-wait'
import type { OrchestrationWorkerLaunchDefaults } from '../../shared/orchestration-worker-model-settings'

export class OrcaRuntimeWithGetOrchestrationWorkerLaunchDefaults extends OrcaRuntimeWithGetTerminalInteractiveWait {
  getOrchestrationWorkerLaunchDefaults(): OrchestrationWorkerLaunchDefaults {
    const settings = this.store?.getSettings()
    return {
      agent: settings?.orchestrationDefaultWorkerAgent ?? null,
      models: settings?.orchestrationWorkerModels ?? {},
      efforts: settings?.orchestrationWorkerEfforts ?? {}
    }
  }
}
