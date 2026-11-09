import type { WorkerStopReceipt } from '../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import {
  ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
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
  return `${serverName} did not answer, so Orca cannot tell whether the stop reached the worker. Orca asks again when ${serverName} is back; worker-show shows when it lands.`
}

/** A resend keeps one request across attempts, so a stop the server applied but whose answer was lost is
 *  replayed by the server rather than run again. */
function owedStopRequestId(dispatchId: string): string {
  return `owed-stop:${dispatchId}`
}

// One stop at a time per Dispatch, manual or resent: a manual stop waits out a resend in flight.
const stopFlights = new WeakMap<OrchestrationDb, Map<string, Promise<unknown>>>()

function inStopFlight<T>(
  db: OrchestrationDb,
  dispatchId: string,
  run: () => Promise<T>
): Promise<T> {
  let flights = stopFlights.get(db)
  if (!flights) {
    flights = new Map()
    stopFlights.set(db, flights)
  }
  const flight = (flights.get(dispatchId) ?? Promise.resolve()).catch(() => undefined).then(run)
  flights.set(dispatchId, flight)
  const owned = flights
  void flight
    .catch(() => undefined)
    .finally(() => {
      if (owned.get(dispatchId) === flight) {
        owned.delete(dispatchId)
      }
    })
  return flight
}

/** worker-stop for a worker on a paired server. A stop the server gave no answer to is kept owed and sent later. */
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
  return inStopFlight(db, dispatchId, async () => {
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
    return sendFederatedStop(runtime, db, server, dispatchId, orchestrationMutation.requestId)
  })
}

/** The relay calls this once the server answers again; only a stop the server never answered is sent. */
export async function resendOwedFederatedStop(
  runtime: Omit<FederatedStopRuntime, 'getRuntimeId'>,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  if (stopFlights.get(db)?.has(dispatchId) || !isStopOwed(db, dispatchId)) {
    return
  }
  const federated = db.getFederatedDispatch(dispatchId)
  if (!federated) {
    return
  }
  const server = resolvePinnedFederatedServer(runtime, federated)
  await inStopFlight(db, dispatchId, async () => {
    try {
      await refuseFederatedStopWhileKeptOpen(runtime, federated)
    } catch (error) {
      if (
        !isServerUnreachable(error) &&
        runtime.getOrchestrationDb() === db &&
        isStopOwed(db, dispatchId)
      ) {
        // Kept open on the server since: the stop is not sent, and it is no longer owed.
        db.markWorkerStopUnknown(
          dispatchId,
          error instanceof Error ? error.message : String(error),
          'stop_outcome_unknown'
        )
      }
      return
    }
    // Re-read after the wait: a manual stop or a profile switch may have settled or replaced it.
    if (runtime.getOrchestrationDb() === db && isStopOwed(db, dispatchId)) {
      await sendFederatedStop(runtime, db, server, dispatchId, owedStopRequestId(dispatchId))
    }
  })
}

function isStopOwed(db: OrchestrationDb, dispatchId: string): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  return worker?.state === 'stop_unknown' && worker.stage === 'stop_owed'
}

async function sendFederatedStop(
  runtime: Omit<FederatedStopRuntime, 'getRuntimeId'>,
  db: OrchestrationDb,
  server: ReturnType<typeof resolvePinnedFederatedServer>,
  dispatchId: string,
  requestId: string
): Promise<WorkerStopReceipt> {
  const call = federatedStopCall(runtime, server)
  // Every write after a wait goes to the database the stop began in, and only while it is still current.
  const fenced = <T>(write: () => T): T => {
    if (runtime.getOrchestrationDb() !== db) {
      throw new OrchestrationError(
        'operation_unknown',
        `The orchestration database changed while Dispatch ${dispatchId} was stopping.`
      )
    }
    return write()
  }
  // A concurrent path may have settled it meanwhile; that settlement stands.
  const stillUnknown = (reason: string, stage?: 'stop_owed' | 'stop_outcome_unknown') =>
    fenced(() =>
      db.getWorkerDispatch(dispatchId)?.state === 'stopped'
        ? (db.getWorkerDispatch(dispatchId) as { state: string; last_error: string | null })
        : db.markWorkerStopUnknown(dispatchId, reason, stage)
    )
  try {
    const status = RemoteCapabilities.parse(await call('status.get'))
    if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)) {
      return unknownReceipt(
        dispatchId,
        stillUnknown(`Connected server ${server.name} cannot prove the worker stop outcome.`),
        'none'
      )
    }
    const remote = RemoteStopReceipt.parse(
      await call('orchestration.federationStop', { dispatchId }, requestId)
    )
    if (remote.state === 'stopped') {
      const worker = fenced(() => db.reconcileFederatedWorkerStop(dispatchId))
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
      fenced(() => db.resumeFederatedWorkerForTerminalRelay(dispatchId))
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
        stillUnknown(remote.lastError ?? `The worker server returned ${remote.state}.`),
        remote.processAction
      ),
      ...remoteHelpers(remote, status, server.name)
    }
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'operation_unknown') {
      throw error
    }
    // No answer leaves the stop owed and asked again; an answer Orca could not read leaves it unknown.
    const unanswered = isServerUnreachable(error)
    const reason = unanswered
      ? owedStopReason(server.name)
      : error instanceof Error
        ? error.message
        : String(error)
    return unknownReceipt(
      dispatchId,
      stillUnknown(reason, unanswered ? 'stop_owed' : 'stop_outcome_unknown'),
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
