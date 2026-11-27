import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeOrchestrationEnvelope } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { isOrchestrationMutation } from '../../../../shared/orchestration/orchestration-rpc-contract'
import type {
  OrchestrationEnvironmentCallOptions,
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from './environment-transport'
import { OrchestrationError } from '../orchestration-error'
import { UnsentRequestError } from './unsent-request-error'
import {
  sendOnContractVerifiedRuntime,
  sendOnPinnedRuntime
} from './federation-contract-runtime-pin'
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

  async resolveWorkerServer(selector: string): Promise<OrchestrationWorkerServer> {
    if (!this.transport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    return await this.transport.resolve(selector)
  }

  async listWorkerServers(): Promise<readonly { environmentId: string; name: string }[]> {
    return (await this.transport?.list?.()) ?? []
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
    if (envelope?.orchestrationPeerWorkTarget && !internal?.expectedEnvironmentRuntimeId) {
      throw new UnsentRequestError(
        'runtime_environment_changed',
        'A targeted follow-up call requires a verified server runtime instance. No effects were applied.',
        { effectsApplied: false }
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
        {
          prepareRequest: internal?.prepareRequest,
          prepareGuard: internal?.prepareGuard,
          expectedRuntimeId,
          ...(internal?.forceStatusProbe ? { forceStatusProbe: true as const } : {})
        }
      )
    const pinnedRuntimeId = internal?.expectedEnvironmentRuntimeId
    const response =
      pinnedRuntimeId !== undefined
        ? await sendOnPinnedRuntime({
            contractVerifiedRuntimeIds: this.contractVerifiedRuntimeIds,
            transport,
            selector,
            expectedRuntimeId: pinnedRuntimeId,
            verifyContract: isOrchestrationMutation(method, params) && !internal?.contractVerified,
            send,
            timeoutMs,
            internal
          })
        : isOrchestrationMutation(method, params) && !internal?.contractVerified
          ? await sendOnContractVerifiedRuntime({
              contractVerifiedRuntimeIds: this.contractVerifiedRuntimeIds,
              transport,
              selector,
              send,
              timeoutMs,
              internal
            })
          : await send()
    if (response.ok === false) {
      throw new OrchestrationError(response.error.code, response.error.message, response.error.data)
    }
    return response.result
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
      async (): Promise<FederationRelayTickOutcome> => {
        if (!(await this.isEnvironmentRemoved(dispatchId))) {
          return 'failed'
        }
        this.warnings.delete(dispatchId)
        return 'ended'
      }
    )
  }

  /** Checked only after a failed sync; a store read error keeps the relay retrying. */
  private async isEnvironmentRemoved(dispatchId: string): Promise<boolean> {
    const environmentId = this.runtime
      .getOrchestrationDb()
      .getFederatedDispatch(dispatchId)?.environment_id
    if (environmentId === undefined) {
      return false
    }
    try {
      // A removed server cannot answer; the next ensureRelay re-arms it if the server is added back.
      return (await this.transport?.hasEnvironment?.(environmentId)) === false
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
