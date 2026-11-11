import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../shared/runtime-rpc-envelope'
import {
  isOrchestrationMutation,
  orchestrationMigrationData
} from '../../../../shared/orchestration/orchestration-rpc-contract'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import type {
  OrchestrationEnvironmentCallOptions,
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from './environment-transport'
import { OrchestrationError } from '../orchestration-error'
import {
  clearFederationAckCheckpoints,
  releaseFederationAckCheckpoint
} from '../legacy-remote-home/federation-ack-checkpoints'
import {
  federatedSyncMovedMail,
  syncFederatedDispatch,
  type FederatedSyncResult
} from '../legacy-remote-home/federation-sync'
import { FederationAcknowledgmentRecovery } from '../legacy-remote-home/federation-acknowledgment-recovery'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { FederationRuntime } from './federation-runtime'
import {
  FederationRelayScheduler,
  type FederationRelayTickOutcome
} from './relay/federation-relay-scheduler'

export class RuntimeOrchestrationFederation {
  private readonly relays = new FederationRelayScheduler((dispatchId) => this.relayTick(dispatchId))
  private readonly acknowledgmentRecovery = new FederationAcknowledgmentRecovery({
    findNextAfter: (afterRowId) =>
      this.runtime
        .getOrchestrationDb()
        .findNextTerminalFederatedDispatchPendingAcknowledgment(afterRowId),
    sync: (dispatchId) => this.runtime.syncOrchestrationFederatedDispatch(dispatchId),
    acknowledgedThrough: (dispatchId) =>
      this.runtime.getOrchestrationDb().getFederatedDispatch(dispatchId)
        ?.to_home_acknowledged_sequence ?? null
  })
  private readonly syncs = new Map<
    string,
    { db: OrchestrationDb; promise: Promise<FederatedSyncResult> }
  >()
  private readonly warnings = new Set<string>()
  private relayGeneration = 0
  private stopVerifiedWatch: (() => void) | null = null
  /** Worker server -> runtime incarnation that last proved the orchestration contract. */
  private readonly contractVerifiedRuntimeIds = new Map<string, string>()

  constructor(
    private readonly runtime: FederationRuntime,
    private readonly transport: OrchestrationEnvironmentTransport | null
  ) {}

  resetForDatabaseChange(): void {
    this.relayGeneration += 1
    this.unwatchVerifiedEnvironments()
    this.relays.clear()
    this.acknowledgmentRecovery.reset()
    clearFederationAckCheckpoints(this.runtime)
    this.syncs.clear()
    this.warnings.clear()
  }

  resolveWorkerServer(selector: string): OrchestrationWorkerServer {
    if (!this.transport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    return this.transport.resolve(selector)
  }

  async callWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    internal?: OrchestrationEnvironmentCallOptions
  ): Promise<unknown> {
    const transport = this.transport
    if (!transport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    const send = (expectedRuntimeId?: string) =>
      transport.call(
        selector,
        method,
        params,
        timeoutMs,
        method.startsWith('orchestration.')
          ? { ...envelope, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
          : envelope,
        internal?.expectedEnvironmentPairingRevision,
        { prepareRequest: internal?.prepareRequest, expectedRuntimeId }
      )
    const response =
      isOrchestrationMutation(method, params) && !internal?.contractVerified
        ? await this.sendOnContractVerifiedRuntime(transport, selector, send, timeoutMs, internal)
        : await send()
    if (response.ok === false) {
      throw new OrchestrationError(response.error.code, response.error.message, response.error.data)
    }
    return response.result
  }

  /** Pins a mutation to the incarnation that proved the contract, so a restarted host refuses it before any effect. */
  private async sendOnContractVerifiedRuntime(
    transport: OrchestrationEnvironmentTransport,
    selector: string,
    send: (expectedRuntimeId: string) => Promise<RuntimeRpcResponse<unknown>>,
    timeoutMs: number | undefined,
    internal: OrchestrationEnvironmentCallOptions | undefined
  ): Promise<RuntimeRpcResponse<unknown>> {
    const verifiedRuntimeId = this.contractVerifiedRuntimeIds.get(selector)
    if (verifiedRuntimeId) {
      const response = await send(verifiedRuntimeId)
      if (response.ok || response.error.code !== 'runtime_environment_changed') {
        return response
      }
      this.contractVerifiedRuntimeIds.delete(selector)
    }
    return send(await this.verifyWorkerServerContract(transport, selector, timeoutMs, internal))
  }

  /** Proves the current orchestration contract and returns the incarnation that proved it. */
  private async verifyWorkerServerContract(
    transport: OrchestrationEnvironmentTransport,
    selector: string,
    timeoutMs: number | undefined,
    internal: OrchestrationEnvironmentCallOptions | undefined
  ): Promise<string> {
    const statusResponse = await transport.call(
      selector,
      'status.get',
      undefined,
      timeoutMs,
      undefined,
      internal?.expectedEnvironmentPairingRevision
    )
    if (statusResponse.ok === false) {
      throw new OrchestrationError(
        statusResponse.error.code,
        statusResponse.error.message,
        statusResponse.error.data
      )
    }
    const status = statusResponse.result as RuntimeStatus
    if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
      throw new OrchestrationError(
        'orchestration_migration_required',
        'The connected worker server does not support the current orchestration contract. No effects were applied.',
        orchestrationMigrationData('runtime_capability_missing')
      )
    }
    this.contractVerifiedRuntimeIds.set(selector, statusResponse._meta.runtimeId)
    return statusResponse._meta.runtimeId
  }

  async sync(runId?: string): Promise<void> {
    if (!this.transport) {
      return
    }
    const dispatches = this.runtime.getOrchestrationDb().listActiveFederatedDispatches(runId)
    await Promise.allSettled(dispatches.map((dispatch) => this.syncDispatch(dispatch.dispatch_id)))
  }

  syncDispatch(dispatchId: string): Promise<FederatedSyncResult> {
    const db = this.runtime.getOrchestrationDb()
    const current = this.syncs.get(dispatchId)
    if (current?.db === db) {
      return current.promise
    }
    const generation = this.relayGeneration
    const isCurrent = (): boolean =>
      generation === this.relayGeneration && this.runtime.getOrchestrationDb() === db
    const sync = syncFederatedDispatch(this.runtime, dispatchId, isCurrent)
      .then((result) => {
        if (this.syncs.get(dispatchId)?.promise === sync) {
          this.warnings.delete(dispatchId)
          this.relays.noteSynced(dispatchId, federatedSyncMovedMail(result))
        }
        return result
      })
      .catch((error: unknown) => {
        if (this.syncs.get(dispatchId)?.promise === sync && !this.warnings.has(dispatchId)) {
          console.warn(`[orchestration] Federation sync failed for ${dispatchId}:`, error)
          this.warnings.add(dispatchId)
        }
        throw error
      })
      .finally(() => {
        if (this.syncs.get(dispatchId)?.promise !== sync) {
          return
        }
        this.syncs.delete(dispatchId)
        if (!db.isFederatedDispatchRelayEligible(dispatchId)) {
          releaseFederationAckCheckpoint(this.runtime, dispatchId)
        }
      })
    this.syncs.set(dispatchId, { db, promise: sync })
    return sync
  }

  async syncDispatchAfterCurrent(dispatchId: string): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    const generation = this.relayGeneration
    const current = this.syncs.get(dispatchId)
    if (current?.db === db) {
      await current.promise.catch(() => undefined)
    }
    if (generation !== this.relayGeneration || this.runtime.getOrchestrationDb() !== db) {
      return
    }
    await this.syncDispatch(dispatchId)
  }

  /** keepAwake: a coordinator still waiting re-arms; it holds the base cadence without forcing a sync or cutting a failure backoff. */
  ensureRelay(runId?: string, options?: { keepAwake?: boolean }): void {
    if (!this.transport) {
      return
    }
    this.stopVerifiedWatch ??=
      this.transport.onEnvironmentVerified?.((environmentId) =>
        this.relays.resetEnvironment(environmentId)
      ) ?? null
    for (const dispatch of this.runtime.getOrchestrationDb().listActiveFederatedDispatches(runId)) {
      if (options?.keepAwake) {
        this.relays.keepAwake(dispatch.dispatch_id, dispatch.environment_id)
      } else {
        this.relays.arm(dispatch.dispatch_id, dispatch.environment_id)
      }
    }
    this.acknowledgmentRecovery.ensure()
  }

  private async relayTick(dispatchId: string): Promise<FederationRelayTickOutcome> {
    if (!this.runtime.getOrchestrationDb().isFederatedDispatchRelayEligible(dispatchId)) {
      this.warnings.delete(dispatchId)
      return 'ended'
    }
    return this.syncDispatch(dispatchId).then(
      (result): FederationRelayTickOutcome => (federatedSyncMovedMail(result) ? 'moved' : 'idle'),
      (): FederationRelayTickOutcome => {
        if (!this.isEnvironmentRemoved(dispatchId)) {
          return 'failed'
        }
        this.warnings.delete(dispatchId)
        return 'ended'
      }
    )
  }

  /** Checked only after a failed sync; a store read error keeps the relay retrying. */
  private isEnvironmentRemoved(dispatchId: string): boolean {
    const environmentId = this.runtime
      .getOrchestrationDb()
      .getFederatedDispatch(dispatchId)?.environment_id
    if (environmentId === undefined) {
      return false
    }
    try {
      // A removed server cannot answer; the next ensureRelay re-arms it if the server is added back.
      return this.transport?.hasEnvironment?.(environmentId) === false
    } catch {
      return false
    }
  }

  private unwatchVerifiedEnvironments(): void {
    this.stopVerifiedWatch?.()
    this.stopVerifiedWatch = null
  }

  stopRelay(): void {
    this.relayGeneration += 1
    this.unwatchVerifiedEnvironments()
    this.relays.clear()
    this.acknowledgmentRecovery.reset()
    this.warnings.clear()
    this.syncs.clear()
    clearFederationAckCheckpoints(this.runtime)
  }
}
