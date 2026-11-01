// #36853: a headless serve is the Run home for workers on connected servers, so its runtime
// federation dials paired environments through the same transport the desktop wires.
import { getAppEnvironment } from '../../shared/app-environment'
import { createOrchestrationEnvironmentTransport } from '../ipc/runtime-environments/orchestration-environment-transport'

/** Constructor options that give the orcad runtime the paired-environment transport. */
export function orcadOrchestrationTransportOptions() {
  return {
    orchestrationEnvironmentTransport: createOrchestrationEnvironmentTransport(() =>
      getAppEnvironment().getPath('userData')
    )
  }
}
