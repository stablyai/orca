import type { WorkerStopReceipt } from '../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import { stopFederatedWorker } from '../federation/federated-worker-stop'
import { settledReceipt, unknownReceipt } from './worker-stop-receipts'
import type { RpcContext } from '../../../core'
import { describeUnconfirmedAgentStop } from '../../../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { inspectWorkerTerminal } from './worker-observation'
import { archiveWorkerOutputBeforeStop } from './worker-stop-archive'
import {
  resolveStructuredWorkerForDispatch,
  stopStructuredWorker
} from '../structured-workers/orchestration-structured-worker-lifecycle'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'

export type StopMutation = RpcContext['orchestrationMutation']

/** Fence and stop exactly one Dispatch's worker, as worker-stop always has. */
export async function stopSingleWorker(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  orchestrationMutation: StopMutation
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  if (federated) {
    return stopFederatedWorker(runtime, dispatchId, federated, orchestrationMutation)
  }
  const begun = db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
  if (begun.disposition === 'already_settled') {
    return settledReceipt(dispatchId, begun.worker.state)
  }
  if (begun.disposition === 'context_only') {
    if (!begun.alreadySettled) {
      runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
    }
    return {
      dispatchId,
      state: begun.state,
      alreadySettled: begun.alreadySettled,
      processAction: 'none' as const,
      warning: contextOnlyStopWarning(begun)
    }
  }
  const handle = begun.worker.agent_terminal_handle
  if (!handle) {
    return unknownReceipt(
      dispatchId,
      db.markWorkerStopUnknown(dispatchId, 'The Dispatch has no recorded agent terminal.'),
      'unknown'
    )
  }
  if (isStructuredWorkerHandle(handle)) {
    // Install the structured host after restart or observation/close stay unknown forever.
    await runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => {
      console.warn('[orchestration] structured host install failed before stop', handle, error)
    })
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  const liveHandle = observation.terminalHandle ?? handle
  // The host exit can settle this stop while terminal inspection is awaiting inventory.
  if (db.getWorkerDispatch(dispatchId)?.state === 'stopped') {
    runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
    return {
      dispatchId,
      state: 'stopped',
      alreadySettled: false,
      processAction: 'none'
    }
  }
  // Still attempt stop on unverifiable contact. Structured exited is also addressable: close/hide its current /clear session to prevent restart on mail.
  if (
    !observation.exact ||
    (observation.status !== 'live' &&
      observation.status !== 'unverifiable' &&
      !isStructuredWorkerHandle(handle))
  ) {
    return unknownReceipt(
      dispatchId,
      db.markWorkerStopUnknown(
        dispatchId,
        `The recorded worker process is ${observation.status}; no terminal was closed.`
      ),
      'none'
    )
  }
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (!resource || resource.ownership_state !== 'owned') {
    const ownership = resource?.ownership_state ?? 'unproven'
    return unknownReceipt(
      dispatchId,
      db.markWorkerStopUnknown(
        dispatchId,
        `The worker terminal is ${ownership}; no terminal was closed.`
      ),
      'none'
    )
  }
  await archiveWorkerOutputBeforeStop({
    runtime,
    db,
    dispatchId,
    terminalHandle: liveHandle,
    attachedAt: begun.worker.created_at
  })
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (structured) {
    const stop = await stopStructuredWorker(structured, runtime)
    if (!stop.stopped) {
      // Only proven exit settles; if no close was issued, the receipt must not claim one.
      return unknownReceipt(
        dispatchId,
        db.markWorkerStopUnknown(dispatchId, stop.reason ?? 'The close was not proven.'),
        stop.closeAttempted ? 'closed_agent_terminal' : 'none'
      )
    }
    const stopped = db.settleWorkerStop(dispatchId)
    runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
    return {
      dispatchId,
      state: stopped.state,
      alreadySettled: false,
      processAction: 'closed_agent_terminal'
    }
  }
  const closed = await runtime
    .closeTerminal(liveHandle)
    .then((close) => ({ close }) as const)
    .catch(
      (error: unknown) =>
        ({ error: error instanceof Error ? error.message : String(error) }) as const
    )
  // A concurrent process exit already proves and settles stop; do not re-settle or report uncertainty.
  if (db.getWorkerDispatch(dispatchId)?.state !== 'stopped') {
    if ('error' in closed) {
      return unknownReceipt(
        dispatchId,
        db.markWorkerStopUnknown(dispatchId, closed.error),
        'unknown'
      )
    }
    if (!closed.close.ptyKilled) {
      // Tab retirement alone does not prove the agent stopped.
      return unknownReceipt(
        dispatchId,
        db.markWorkerStopUnknown(dispatchId, describeUnconfirmedAgentStop(closed.close)),
        'closed_agent_terminal'
      )
    }
    db.settleWorkerStop(dispatchId)
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: db.getWorkerDispatch(dispatchId)?.state ?? 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
    ...('close' in closed ? { close: closed.close } : {})
  }
}

function contextOnlyStopWarning(result: {
  state: string
  alreadySettled: boolean
  releasedCurrentTask: boolean
}): string {
  if (result.alreadySettled) {
    return `Dispatch was already ${result.state}; no terminal process changed.`
  }
  return result.releasedCurrentTask
    ? 'The assignment was stopped without closing its unsupervised terminal process.'
    : 'The superseded assignment was stopped without changing the current Task or terminal process.'
}
