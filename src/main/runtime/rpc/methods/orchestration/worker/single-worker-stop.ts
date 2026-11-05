import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RpcContext } from '../../../core'
import { describeUnconfirmedAgentStop } from '../../../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { inspectWorkerTerminal, resolvePinnedFederatedServer } from './worker-observation'
import { refuseFederatedStopWhileKeptOpen } from './worker-keep-open'
import { archiveWorkerOutputBeforeStop } from './worker-stop-archive'
import {
  resolveStructuredWorkerForDispatch,
  stopStructuredWorker
} from '../../orchestration-structured-worker-lifecycle'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'

export type StopMutation = RpcContext['orchestrationMutation']

export type WorkerStopReceipt = {
  dispatchId: string
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
  warning?: string
  helpers?: HelperStopOutcome[]
}

export const HelperStopOutcome = z.object({
  dispatchId: z.string(),
  creatorDispatchId: z.string(),
  outcome: z.enum(['stopped', 'already_finished', 'kept_open', 'starting', 'unconfirmed']),
  state: z.string().optional(),
  lastError: z.string().nullable().optional()
})
export type HelperStopOutcome = z.infer<typeof HelperStopOutcome>

/** Fence and stop exactly one Dispatch's worker, as worker-stop always has. */
export async function stopSingleWorker(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  orchestrationMutation: StopMutation
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  if (federated) {
    if (!orchestrationMutation) {
      throw new OrchestrationError(
        'invalid_argument',
        'Remote worker-stop requires a durable retry request.'
      )
    }
    await refuseFederatedStopWhileKeptOpen(runtime, federated)
    const server = resolvePinnedFederatedServer(runtime, federated)
    const begun = db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    if (begun.disposition === 'already_settled') {
      return settledReceipt(dispatchId, begun.worker.state)
    }
    try {
      const status = (await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'status.get',
        undefined,
        30_000,
        undefined,
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )) as RuntimeStatus
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
      const remote = (await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationStop',
        { dispatchId: dispatchId },
        30_000,
        { orchestrationRequestId: orchestrationMutation.requestId },
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )) as RemoteStopReceipt
      if (remote.state === 'stopped') {
        const worker = db.reconcileFederatedWorkerStop(dispatchId)
        return {
          dispatchId: dispatchId,
          state: worker.state,
          alreadySettled: remote.alreadySettled,
          processAction: remote.processAction,
          close: remote.close,
          ...remoteHelpers(remote)
        }
      }
      if (remote.state === 'succeeded' || remote.state === 'failed') {
        db.resumeFederatedWorkerForTerminalRelay(dispatchId)
        await runtime
          .syncOrchestrationFederatedDispatchAfterCurrent(dispatchId)
          .catch(() => undefined)
        return {
          dispatchId: dispatchId,
          state: db.getWorkerDispatch(dispatchId)?.state ?? remote.state,
          alreadySettled: true,
          processAction: 'none',
          ...remoteHelpers(remote)
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
        ...remoteHelpers(remote)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return unknownReceipt(dispatchId, db.markWorkerStopUnknown(dispatchId, reason), 'unknown')
    }
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
      dispatchId: dispatchId,
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
      dispatchId: dispatchId,
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
    dispatchId: dispatchId,
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
      dispatchId: dispatchId,
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
    dispatchId: dispatchId,
    state: db.getWorkerDispatch(dispatchId)?.state ?? 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
    ...('close' in closed ? { close: closed.close } : {})
  }
}

type RemoteStopReceipt = {
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
  helpers?: unknown
}

/** Helpers the worker's host stopped under it; an older host reports none. */
function remoteHelpers(remote: RemoteStopReceipt): Pick<WorkerStopReceipt, 'helpers'> {
  const helpers = HelperStopOutcome.array().safeParse(remote.helpers)
  return helpers.success && helpers.data.length ? { helpers: helpers.data } : {}
}

function settledReceipt(dispatchId: string, state: string): WorkerStopReceipt {
  return { dispatchId, state, alreadySettled: true, processAction: 'none' }
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

function unknownReceipt(
  dispatchId: string,
  worker: { state: string; last_error: string | null },
  processAction: string
): WorkerStopReceipt {
  return {
    dispatchId,
    state: worker.state,
    alreadySettled: false,
    processAction,
    lastError: worker.last_error
  }
}
