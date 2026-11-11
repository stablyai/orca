import type {
  OrchestrationEnvironmentCallOptions,
  OrchestrationWorkerServer
} from './environment-transport'
import type { RuntimeOrchestrationEnvelope } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity } from '../../workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity'

export abstract class RuntimeFederationOperations extends OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity {
  resolveOrchestrationWorkerServer(selector: string): OrchestrationWorkerServer {
    return this.orchestrationFederation.resolveWorkerServer(selector)
  }

  callOrchestrationWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    internal?: OrchestrationEnvironmentCallOptions
  ): Promise<unknown> {
    return this.orchestrationFederation.callWorkerServer(
      selector,
      method,
      params,
      timeoutMs,
      envelope,
      internal
    )
  }

  syncOrchestrationFederation(runId?: string): Promise<void> {
    return this.orchestrationFederation.sync(runId)
  }

  syncOrchestrationFederatedDispatch(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatch(dispatchId)
  }

  syncOrchestrationFederatedDispatchAfterCurrent(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatchAfterCurrent(dispatchId)
  }

  ensureOrchestrationFederationRelay(runId?: string): void {
    this.orchestrationFederation.ensureRelay(runId)
  }

  stopOrchestrationFederationRelay(): void {
    this.orchestrationFederation.stopRelay()
  }
}
