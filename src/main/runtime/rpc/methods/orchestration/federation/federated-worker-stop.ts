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

/** One request per owed cycle: a resend the server applied but whose answer was lost is replayed by the
 *  server, not run again. A later explicit stop that goes unanswered starts a new cycle, and a new request. */
function owedStopRequestId(dispatchId: string, owedSince: string): string {
  return `owed-stop:${dispatchId}:${owedSince}`
}

/** This runtime replaced its database or relay mid-stop: nothing more is sent or written. */
class StopFenceError extends OrchestrationError {
  constructor(dispatchId: string) {
    super(
      'operation_unknown',
      `The orchestration database changed while Dispatch ${dispatchId} was stopping.`
    )
  }
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
  const current = () => runtime.getOrchestrationDb() === db
  return inStopFlight(db, dispatchId, async () => {
    if (!current()) {
      throw new StopFenceError(dispatchId)
    }
    // A stop already recorded as unknown is retried as it stands: it is never begun twice.
    if (db.getWorkerDispatch(dispatchId)?.state !== 'stop_unknown') {
      const begun = db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
      if (begun.disposition === 'already_settled') {
        return stopSettledFederatedHelpers(
          runtime,
          server,
          dispatchId,
          begun.worker.state,
          orchestrationMutation.requestId,
          current
        )
      }
    }
    return sendFederatedStop(runtime, db, server, dispatchId, {
      requestId: orchestrationMutation.requestId,
      current
    })
  })
}

/** The relay calls this once the server answers again; only a stop the server never answered is sent. */
export async function resendOwedFederatedStop(
  runtime: Omit<FederatedStopRuntime, 'getRuntimeId'>,
  dispatchId: string,
  /** The relay generation that asked; a stopped or reset relay sends nothing more. */
  relayCurrent: () => boolean
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const current = () => relayCurrent() && runtime.getOrchestrationDb() === db
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
      if (!isServerUnreachable(error) && current() && isStopOwed(db, dispatchId)) {
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
    const owed = db.getWorkerDispatch(dispatchId)
    if (current() && owed && isStopOwed(db, dispatchId)) {
      await sendFederatedStop(runtime, db, server, dispatchId, {
        requestId: owedStopRequestId(dispatchId, owed.updated_at),
        current,
        resend: true
      })
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
  attempt: {
    requestId: string
    /** False once this runtime replaced its database or relay: nothing more is sent or written. */
    current: () => boolean
    /** A relay resend of an owed stop: unanswered again, it stays in the same owed cycle. */
    resend?: boolean
  }
): Promise<WorkerStopReceipt> {
  const call = federatedStopCall(runtime, server)
  const fenced = <T>(write: () => T): T => {
    if (!attempt.current()) {
      throw new StopFenceError(dispatchId)
    }
    return write()
  }
  // A concurrent path may have settled it meanwhile, and a resend unanswered again keeps its cycle.
  const stillUnknown = (reason: string, stage?: 'stop_owed' | 'stop_outcome_unknown') =>
    fenced(() => {
      const now = db.getWorkerDispatch(dispatchId)
      const keep =
        now?.state === 'stopped' ||
        (attempt.resend && stage === 'stop_owed' && now?.stage === 'stop_owed')
      return now && keep ? now : db.markWorkerStopUnknown(dispatchId, reason, stage)
    })
  try {
    const status = RemoteCapabilities.parse(await call('status.get'))
    if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)) {
      return unknownReceipt(
        dispatchId,
        stillUnknown(`Connected server ${server.name} cannot prove the worker stop outcome.`),
        'none'
      )
    }
    // Checked before the only call with an effect on the server.
    fenced(() => undefined)
    const remote = RemoteStopReceipt.parse(
      await call('orchestration.federationStop', { dispatchId }, attempt.requestId)
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
    if (error instanceof StopFenceError) {
      throw error
    }
    // No answer leaves the stop owed and asked again; any other answer, the server's own
    // operation_unknown included, leaves it unknown for an explicit retry.
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
  requestId: string,
  current: () => boolean
): Promise<WorkerStopReceipt> {
  const settled = settledReceipt(dispatchId, state)
  const call = federatedStopCall(runtime, server)
  try {
    const status = RemoteCapabilities.parse(await call('status.get'))
    if (!status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY)) {
      return settled
    }
    if (!current()) {
      throw new StopFenceError(dispatchId)
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
