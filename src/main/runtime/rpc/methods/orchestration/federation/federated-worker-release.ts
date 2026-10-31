import {
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { z } from 'zod'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import {
  releaseUnknownRecovery,
  type WorkerReleaseReceipt
} from '../worker/worker-release-completion'
import type { resolvePinnedFederatedServer } from '../worker/worker-observation'

type RemoteReleaseReceipt = Omit<WorkerReleaseReceipt, 'archive'> & {
  archive?: WorkerReleaseReceipt['archive']
  output?: { source?: string }
}

const RemoteReleaseReceiptSchema = z
  .object({
    dispatchId: z.string().min(1),
    state: z.enum([
      'released',
      'already_released',
      'retained',
      'release_pending',
      'release_unknown'
    ]),
    reason: z.string().optional(),
    processAction: z.enum(['closed_agent_terminal', 'closed_exited_terminal', 'none']),
    archive: z
      .object({ source: z.string().nullable(), status: z.string().nullable() })
      .nullable()
      .optional(),
    recovery: z.string().optional(),
    lastError: z.string().optional(),
    output: z.unknown().optional()
  })
  .passthrough()

type FederatedWorkerMutationArgs = {
  runtime: WorkerTerminalReleaseRuntime
  server: ReturnType<typeof resolvePinnedFederatedServer>
  federated: FederatedDispatchRow
  dispatchId: string
  requestId: string
}

export async function resolveExecutionHostCapability(
  args: FederatedWorkerMutationArgs,
  capability: string
): Promise<{ supported: boolean; runtimeEpoch: string }> {
  const resolved = await getOrchestrationPeerCapabilityCache(args.runtime).resolve({
    peerFingerprint: args.federated.peer_fingerprint,
    expectedRuntimeEpoch: args.federated.remote_runtime_epoch,
    capability,
    probe: () =>
      args.runtime.callOrchestrationWorkerServer(
        args.server.environmentId,
        'status.get',
        undefined,
        15_000,
        undefined,
        { expectedEnvironmentPairingRevision: args.server.pairingRevision }
      ) as Promise<RuntimeStatus>
  })
  args.runtime
    .getOrchestrationDb()
    .updateFederatedDispatchRuntimeEpoch(args.dispatchId, resolved.runtimeEpoch)
  return resolved
}

/** Retain where the terminal lives; null means the host predates automatic release, so nothing there can close it unasked. */
export async function retainFederatedWorker(
  args: FederatedWorkerMutationArgs
): Promise<WorkerReleaseReceipt | null> {
  const capability = await resolveExecutionHostCapability(
    args,
    ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY
  )
  if (!capability.supported) {
    return null
  }
  const remote = parseRemoteReleaseReceipt(
    await args.runtime.callOrchestrationWorkerServer(
      args.server.environmentId,
      'orchestration.federationRetain',
      { dispatchId: args.dispatchId },
      30_000,
      { orchestrationRequestId: args.requestId },
      { expectedEnvironmentPairingRevision: args.server.pairingRevision }
    ),
    args.dispatchId
  )
  return {
    dispatchId: args.dispatchId,
    state: remote.state,
    reason: remote.reason,
    processAction: remote.processAction,
    archive: remote.archive ?? null,
    recovery: remote.recovery,
    lastError: remote.lastError
  }
}

export async function releaseFederatedWorker(
  args: FederatedWorkerMutationArgs & {
    // Checked with no await before the send, so a retain made while capabilities resolved still wins.
    admit?: () => boolean
  }
): Promise<WorkerReleaseReceipt & { remoteOutput?: unknown }> {
  const cache = getOrchestrationPeerCapabilityCache(args.runtime)
  // Require advertised durable pre-close archives; method_not_found alone cannot promise that safety.
  const capability = await resolveExecutionHostCapability(
    args,
    ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY
  )
  if (!capability.supported) {
    return unsupported(args.dispatchId)
  }
  if (args.admit && !args.admit()) {
    return {
      dispatchId: args.dispatchId,
      state: 'retained',
      reason: 'user_requested',
      processAction: 'none',
      archive: null
    }
  }
  let remote: RemoteReleaseReceipt
  try {
    remote = parseRemoteReleaseReceipt(
      await args.runtime.callOrchestrationWorkerServer(
        args.server.environmentId,
        'orchestration.federationRelease',
        { dispatchId: args.dispatchId },
        30_000,
        { orchestrationRequestId: args.requestId },
        { expectedEnvironmentPairingRevision: args.server.pairingRevision }
      ),
      args.dispatchId
    )
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'method_not_found') {
      cache.remember(
        args.federated.peer_fingerprint,
        capability.runtimeEpoch,
        ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
        false
      )
      return unsupported(args.dispatchId)
    }
    return {
      dispatchId: args.dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: null,
      lastError: error instanceof Error ? error.message : String(error),
      recovery: `The execution host did not acknowledge release; reconnect before continuing. ${releaseUnknownRecovery(args.dispatchId)} Do not infer process exit.`
    }
  }
  const receipt = {
    dispatchId: args.dispatchId,
    state: remote.state,
    reason: remote.reason,
    processAction: remote.processAction,
    archive: remote.archive ?? null,
    recovery: remote.recovery,
    lastError: remote.lastError,
    ...(remote.output ? { remoteOutput: remote.output } : {})
  }
  if (remote.state !== 'released' && remote.state !== 'already_released') {
    return receipt
  }
  try {
    // Converge the home projection idempotently without repeating a host-confirmed terminal close.
    applyConfirmedFederatedReleaseHomeProjection(args.runtime.getOrchestrationDb(), args.dispatchId)
    return receipt
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ...receipt,
      lastError: `The execution host acknowledged ${remote.state}, but Orca could not apply the confirmed release to the home projection: ${detail}`,
      recovery: confirmedReleaseProjectionRecovery(args.dispatchId)
    }
  }
}

export function parseRemoteReleaseReceipt(
  value: unknown,
  expectedDispatchId: string
): RemoteReleaseReceipt {
  const parsed = RemoteReleaseReceiptSchema.safeParse(value)
  if (!parsed.success || parsed.data.dispatchId !== expectedDispatchId) {
    throw new OrchestrationError(
      'invalid_runtime_response',
      `The execution host returned an invalid release receipt for Dispatch ${expectedDispatchId}.`
    )
  }
  return parsed.data as RemoteReleaseReceipt
}

function confirmedReleaseProjectionRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then retry worker-release with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays the confirmed remote receipt without reapplying the home projection. Never substitute a broad terminal close.`
}

/** Also applied when host observation reports a release the host made on its own. */
export function applyConfirmedFederatedReleaseHomeProjection(
  db: OrchestrationDb,
  dispatchId: string
): void {
  db.db.exec('SAVEPOINT federated_release_home_projection')
  try {
    const worker = db.getWorkerDispatch(dispatchId)
    if (worker && (worker.agent_terminal_handle !== null || worker.stage !== 'released')) {
      // Keep the worker lifecycle state (ready/succeeded/failed) intact; release
      // is terminal cleanup, not a worker outcome.
      db.transitionLifecycle({
        entity: 'worker',
        id: dispatchId,
        from: worker.state,
        to: worker.state,
        projection: {
          stage: 'released',
          agent_terminal_handle: null,
          updated_at: new Date().toISOString()
        }
      })
    }
    // Clear the host handle only after confirmation so later home reads cannot close a stale target.
    db.db
      .prepare(
        `UPDATE federated_dispatches
         SET remote_terminal_handle = NULL, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)
    db.db.exec('RELEASE federated_release_home_projection')
  } catch (error) {
    db.db.exec('ROLLBACK TO federated_release_home_projection')
    db.db.exec('RELEASE federated_release_home_projection')
    throw error
  }
}

function unsupported(dispatchId: string): WorkerReleaseReceipt {
  return {
    dispatchId,
    state: 'retained',
    reason: 'federation_unsupported',
    processAction: 'none',
    archive: null,
    recovery: 'The connected worker server does not advertise remote release; inspect it directly.'
  }
}
