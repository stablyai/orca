import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

export class OrcaRuntimeWithCrossMachineRecovery extends OrcaRuntimeWithResolveWaiter {
  /** The persisted profile store and live hook rows a cross-machine recovery export projects. */
  readCrossMachineRecoveryHostState() {
    return {
      store: this.requireStore(),
      agentStatuses: this.getAgentStatusSnapshotFn?.() ?? []
    }
  }
}
