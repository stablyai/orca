import { randomUUID } from 'node:crypto'
import type { WorkerStopReceipt } from '../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import {
  ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import { refuseFederatedStopWhileKeptOpen } from '../worker/worker-keep-open'
import { resolvePinnedFederatedServer } from '../worker/worker-observation'
import {
  RemoteCapabilities,
  RemoteStopReceipt,
  remoteHelpers
} from '../worker/worker-stop-remote-receipt'
import { settledReceipt, unknownReceipt } from '../worker/worker-stop-receipts'

type FederatedStopRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'getRuntimeId'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'syncOrchestrationFederatedDispatchAfterCurrent'
>

/** Off, asleep or off the network: the server gave no answer at all. */
export function isServerUnreachable(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'remote_runtime_unavailable' || code === 'runtime_timeout'
}

function owedStopReason(serverName: string): string {
  return `${serverName} could not be reached, so the stop has not reached the worker yet. Orca sends it when ${serverName} is back; worker-show shows when it lands.`
}

/** worker-stop for a worker on a paired server. A stop the server never got is kept owed and sent later. */
export async function stopFederatedWorker(
  runtime: FederatedStopRuntime,
  dispatchId: string,
  federated: FederatedDispatchRow,
  orchestrationMutation: RpcContext['orchestrationMutation']
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote worker-stop requires a durable retry request.'
    )
  }
  const server = resolvePinnedFederatedServer(runtime, federated)
  // Without the host's answer nothing is stopped: the user may have kept this worker open there.
  await refuseFederatedStopWhileKeptOpen(runtime, federated)
  // A stop already recorded as unknown is retried as it stands: it is never begun twice.
  if (db.getWorkerDispatch(dispatchId)?.state !== 'stop_unknown') {
    const begun = db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    if (begun.disposition === 'already_settled') {
      return stopSettledFederatedHelpers(
        runtime,
        server,
        dispatchId,
        begun.worker.state,
        orchestrationMutation.requestId
      )
    }
  }
  return sendFederatedStop(runtime, server, dispatchId, orchestrationMutation.requestId)
}

/** The relay calls this once the server answers again; only a stop the server never got is sent. */
export async function resendOwedFederatedStop(
  runtime: Omit<FederatedStopRuntime, 'getRuntimeId'>,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const worker = db.getWorkerDispatch(dispatchId)
  const federated = db.getFederatedDispatch(dispatchId)
  if (worker?.state !== 'stop_unknown' || worker.stage !== 'stop_owed' || !federated) {
    return
  }
  const server = resolvePinnedFederatedServer(runtime, federated)
  try {
    await refuseFederatedStopWhileKeptOpen(runtime, federated)
  } catch (error) {
    if (!isServerUnreachable(error)) {
      // Kept open on the server since: the stop is not sent, and it is no longer owed.
      db.markWorkerStopUnknown(
        dispatchId,
        error instanceof Error ? error.message : String(error),
        'stop_outcome_unknown'
      )
    }
    return
  }
  // A fresh request: the earlier one never reached the server, and the server's stop is idempotent.
  await sendFederatedStop(runtime, server, dispatchId, randomUUID())
}

async function sendFederatedStop(
  runtime: Omit<FederatedStopRuntime, 'getRuntimeId'>,
  server: ReturnType<typeof resolvePinnedFederatedServer>,
  dispatchId: string,
  requestId: string
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  const call = federatedStopCall(runtime, server)
  try {
    const status = RemoteCapabilities.parse(await call('status.get'))
    if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)) {
      return unknownReceipt(
        dispatchId,
        db.markWorkerStopUnknown(
          dispatchId,
          `Connected server ${server.name} cannot prove the worker stop outcome.`
        ),
        'none'
      )
    }
    const remote = RemoteStopReceipt.parse(
      await call('orchestration.federationStop', { dispatchId }, requestId)
    )
    if (remote.state === 'stopped') {
      const worker = db.reconcileFederatedWorkerStop(dispatchId)
      return {
        dispatchId,
        state: worker.state,
        alreadySettled: remote.alreadySettled,
        processAction: remote.processAction,
        close: remote.close,
        ...remoteHelpers(remote, status, server.name)
      }
    }
    if (remote.state === 'succeeded' || remote.state === 'failed') {
      db.resumeFederatedWorkerForTerminalRelay(dispatchId)
      await runtime
        .syncOrchestrationFederatedDispatchAfterCurrent(dispatchId)
        .catch(() => undefined)
      return {
        dispatchId,
        state: db.getWorkerDispatch(dispatchId)?.state ?? remote.state,
        alreadySettled: true,
        processAction: 'none',
        ...remoteHelpers(remote, status, server.name)
      }
    }
    return {
      ...unknownReceipt(
        dispatchId,
        db.markWorkerStopUnknown(
          dispatchId,
          remote.lastError ?? `The worker server returned ${remote.state}.`
        ),
        remote.processAction
      ),
      ...remoteHelpers(remote, status, server.name)
    }
  } catch (error) {
    // No answer at all leaves the stop owed; an answer Orca could not read leaves it unknown.
    const unreachable = isServerUnreachable(error)
    const reason = unreachable
      ? owedStopReason(server.name)
      : error instanceof Error
        ? error.message
        : String(error)
    return unknownReceipt(
      dispatchId,
      db.markWorkerStopUnknown(
        dispatchId,
        reason,
        unreachable ? 'stop_owed' : 'stop_outcome_unknown'
      ),
      'unknown'
    )
  }
}

/** Its host may still run helpers an earlier, partial stop left; a capable host stops them. */
async function stopSettledFederatedHelpers(
  runtime: Pick<FederatedStopRuntime, 'callOrchestrationWorkerServer'>,
  server: ReturnType<typeof resolvePinnedFederatedServer>,
  dispatchId: string,
  state: string,
  requestId: string
): Promise<WorkerStopReceipt> {
  const settled = settledReceipt(dispatchId, state)
  const call = federatedStopCall(runtime, server)
  try {
    const status = RemoteCapabilities.parse(await call('status.get'))
    if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY)) {
      return settled
    }
    const remote = await call('orchestration.federationStop', { dispatchId }, requestId)
    return { ...settled, ...remoteHelpers(RemoteStopReceipt.parse(remote), status, server.name) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ...settled,
      helperStopError: `Could not reach ${server.name} to stop helpers this worker started there: ${reason}`
    }
  }
}

function federatedStopCall(
  runtime: Pick<FederatedStopRuntime, 'callOrchestrationWorkerServer'>,
  server: ReturnType<typeof resolvePinnedFederatedServer>
) {
  return (method: string, params?: unknown, requestId?: string) =>
    runtime.callOrchestrationWorkerServer(
      server.environmentId,
      method,
      params,
      30_000,
      requestId ? { orchestrationRequestId: requestId } : undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
}
