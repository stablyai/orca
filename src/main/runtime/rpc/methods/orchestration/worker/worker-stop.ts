import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../../../core'
import { requiredString } from '../../../schemas'
import { describeUnconfirmedAgentStop } from '../../../../../../shared/pty-liveness-verdict'
import { ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { inspectWorkerTerminal, resolvePinnedFederatedServer } from './worker-observation'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

export const ORCHESTRATION_WORKER_STOP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStop',
    params: WorkerDispatchParams,
    handler: (params, { runtime, orchestrationMutation }) =>
      dedupeWorkerStop(runtime, params.dispatch, async () => {
        const db = runtime.getOrchestrationDb()
        const federated = db.getFederatedDispatch(params.dispatch)
        if (federated) {
          if (!orchestrationMutation) {
            throw new OrchestrationError(
              'invalid_argument',
              'Remote worker-stop requires a durable retry request.'
            )
          }
          const server = resolvePinnedFederatedServer(runtime, federated)
          const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
          if (begun.disposition === 'already_settled') {
            return settledReceipt(params.dispatch, begun.worker.state)
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
            if (
              !status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)
            ) {
              return unknownReceipt(
                params.dispatch,
                db.markWorkerStopUnknown(
                  params.dispatch,
                  `Connected server ${server.name} cannot prove the worker stop outcome.`
                ),
                'none'
              )
            }
            const remote = (await runtime.callOrchestrationWorkerServer(
              server.environmentId,
              'orchestration.federationStop',
              { dispatchId: params.dispatch },
              30_000,
              { orchestrationRequestId: orchestrationMutation.requestId },
              { expectedEnvironmentPairingRevision: server.pairingRevision }
            )) as RemoteStopReceipt
            if (remote.state === 'stopped') {
              const worker = db.reconcileFederatedWorkerStop(params.dispatch)
              return {
                dispatchId: params.dispatch,
                state: worker.state,
                alreadySettled: remote.alreadySettled,
                processAction: remote.processAction,
                close: remote.close
              }
            }
            if (remote.state === 'succeeded' || remote.state === 'failed') {
              db.resumeFederatedWorkerForTerminalRelay(params.dispatch)
              await runtime
                .syncOrchestrationFederatedDispatchAfterCurrent(params.dispatch)
                .catch(() => undefined)
              return {
                dispatchId: params.dispatch,
                state: db.getWorkerDispatch(params.dispatch)?.state ?? remote.state,
                alreadySettled: true,
                processAction: 'none'
              }
            }
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(
                params.dispatch,
                remote.lastError ?? `The worker server returned ${remote.state}.`
              ),
              remote.processAction
            )
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(params.dispatch, reason),
              'unknown'
            )
          }
        }

        const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
        if (begun.disposition === 'already_settled') {
          return settledReceipt(params.dispatch, begun.worker.state)
        }
        if (begun.disposition === 'context_only') {
          if (!begun.alreadySettled) {
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
          }
          return {
            dispatchId: params.dispatch,
            state: begun.state,
            alreadySettled: begun.alreadySettled,
            processAction: 'none' as const,
            warning: contextOnlyStopWarning(begun)
          }
        }
        const handle = begun.worker.agent_terminal_handle
        if (!handle) {
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              'The Dispatch has no recorded agent terminal.'
            ),
            'unknown'
          )
        }
        const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
        // The host exit can settle this stop while terminal inspection is awaiting inventory.
        if (db.getWorkerDispatch(params.dispatch)?.state === 'stopped') {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
          return {
            dispatchId: params.dispatch,
            state: 'stopped',
            alreadySettled: false,
            processAction: 'none'
          }
        }
        // Why `unverifiable` still proceeds: losing contact is a reason to report
        // the outcome honestly, never a reason to stop trying to stop the worker.
        if (
          !observation.exact ||
          (observation.status !== 'live' && observation.status !== 'unverifiable')
        ) {
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              `The recorded worker process is ${observation.status}; no terminal was closed.`
            ),
            'none'
          )
        }
        const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
        if (!resource || resource.ownership_state !== 'owned') {
          const ownership = resource?.ownership_state ?? 'unproven'
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              `The worker terminal is ${ownership}; no terminal was closed.`
            ),
            'none'
          )
        }
        const closed = await runtime
          .closeTerminal(handle)
          .then((close) => ({ close }) as const)
          .catch(
            (error: unknown) =>
              ({ error: error instanceof Error ? error.message : String(error) }) as const
          )
        // The process exit can land mid-close and settle the stop from the exit path; that exit
        // is this stop's proof of success, so do not re-settle it or report it as unknown.
        if (db.getWorkerDispatch(params.dispatch)?.state !== 'stopped') {
          if ('error' in closed) {
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(params.dispatch, closed.error),
              'unknown'
            )
          }
          if (!closed.close.ptyKilled) {
            // The tab is retired, but the agent process was never confirmed stopped —
            // settling here is the false success this receipt exists to prevent.
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(params.dispatch, describeUnconfirmedAgentStop(closed.close)),
              'closed_agent_terminal'
            )
          }
          db.settleWorkerStop(params.dispatch)
        }
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        return {
          dispatchId: params.dispatch,
          state: db.getWorkerDispatch(params.dispatch)?.state ?? 'stopped',
          alreadySettled: false,
          processAction: 'closed_agent_terminal',
          ...('close' in closed ? { close: closed.close } : {})
        }
      })
  })
]

const activeStopByRuntime = new WeakMap<OrcaRuntimeService, Map<string, Promise<unknown>>>()

/** Two callers stopping one Dispatch: the second reached `beginWorkerStop` after the first moved
 *  the row to `stopping` and got `dispatch_inactive` instead of the first caller's receipt. */
function dedupeWorkerStop(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  stop: () => Promise<unknown>
): Promise<unknown> {
  let active = activeStopByRuntime.get(runtime)
  if (!active) {
    active = new Map()
    activeStopByRuntime.set(runtime, active)
  }
  const inFlight = active.get(dispatchId)
  if (inFlight) {
    return inFlight
  }
  const started: Promise<unknown> = stop().finally(() => {
    if (active.get(dispatchId) === started) {
      active.delete(dispatchId)
    }
  })
  active.set(dispatchId, started)
  return started
}

type RemoteStopReceipt = {
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
}

function settledReceipt(dispatchId: string, state: string) {
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
) {
  return {
    dispatchId,
    state: worker.state,
    alreadySettled: false,
    processAction,
    lastError: worker.last_error
  }
}
