import { cancelWorkerStartWait } from './start/readiness/worker-start-waits'
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationWorkerReadResult } from '../../../../../../shared/orchestration/workers/orchestration-worker-output'
import { exposeDispatchContext } from './observation/dispatch-context-exposure'
import { contextOnlyAbandonWarning } from '../../../../orchestration/workers/lifecycle/context-only-dispatch-release'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import {
  exposeObservation,
  exposeWorker,
  inspectWorkerTerminal,
  projectFleetWorker,
  showContextOnlyWorker
} from './observation/worker-observation'
import { resolvePinnedFederatedServer } from '../../../../orchestration/legacy-remote-home/pinned-federated-server'
import { readArchivedWorkerOutput } from './output/worker-archive-read'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import { readStructuredWorkerOutput } from '../structured-workers/orchestration-structured-worker-lifecycle'
import { releaseStructuredWorkerSession } from '../structured-workers/orchestration-structured-worker-session'
import { sessionIdFromStructuredWorkerIncarnation } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { readExactWorkerOutput } from './output/worker-output'
import { projectWorkerShowCustody } from './observation/worker-show-custody'
import { liveWorkerTerminalAutoReleaseAt } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import { failedWorkerStartHasOutput } from '../../../../orchestration/workers/turn-stops/failed-worker-start-report'
import { readFederatedWorkerOutput } from '../../../../orchestration/legacy-remote-home/federated-worker-read'
import { showFederatedWorker } from '../../../../orchestration/legacy-remote-home/federated-worker-show'
import { settleRestartCutStart } from '../../../../orchestration/workers/turn-stops/awaiting-worker-start-report'
import {
  WorkerDispatchParams,
  WorkerReadParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-control-params'

export const ORCHESTRATION_WORKER_CONTROL_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerShow',
    access: { kind: 'reads', targets: { dispatch: 'dispatch' } },
    permission: 'workspace',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      let worker = db.getWorkerDispatch(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} was not found.`
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        return showFederatedWorker({
          runtime,
          db,
          dispatchId: params.dispatch,
          dispatch,
          federated
        })
      }
      if (!worker) {
        return showContextOnlyWorker(runtime, db, dispatch)
      }
      if (worker.state === 'starting') {
        worker = settleRestartCutStart(db, params.dispatch, runtime) ?? worker
      } else if (
        worker.state === 'stopping' &&
        worker.runtime_epoch &&
        worker.runtime_epoch !== runtime.getRuntimeId()
      ) {
        worker = db.markWorkerStopUnknown(
          params.dispatch,
          'The runtime restarted before worker-stop reached a terminal receipt.'
        )
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      return {
        dispatch: exposeDispatchContext(dispatch),
        worker: exposeWorker(worker),
        ...projectWorkerShowCustody(runtime, db, params.dispatch, resource),
        terminal: observation.exact ? observation.terminal : null,
        observation: exposeObservation(observation),
        autoReleaseAt: liveWorkerTerminalAutoReleaseAt(resource),
        coordinatedFrom: db.getPeerRun(dispatch.run_id)?.home_label ?? null
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerRead',
    access: { kind: 'reads', targets: { dispatch: 'dispatch' } },
    permission: 'workspace',
    params: WorkerReadParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      const worker = db.getWorkerDispatch(params.dispatch)
      // A start that never ran in a terminal has only its failure, on any host.
      if (worker?.state === 'failed' && !failedWorkerStartHasOutput(db, worker, dispatch)) {
        throw new OrchestrationError(
          'worker_never_started',
          `Worker Dispatch ${params.dispatch} never started: ${worker.last_error ?? 'its start failed'}`
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        const server = await resolvePinnedFederatedServer(runtime, federated)
        return readFederatedWorkerOutput({
          runtime,
          db,
          server,
          federated,
          dispatchId: params.dispatch,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit
        })
      }
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      // Two verdicts: status.liveness is the output source's, the projection is the agent's.
      const output = await readLocalWorkerOutput(runtime, params, dispatch, worker)
      return { ...output, projection: projectFleetWorker(runtime, db, params.dispatch) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerAbandon',
    access: { kind: 'writes', targets: { dispatch: 'dispatch' } },
    permission: 'workspace',
    params: WorkerDispatchParams,
    handler: (params, { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      // Session identity wins; a terminal-only caller is identified by its launch evidence and pane.
      const caller = orchestrationCaller
        ? { handle: orchestrationCaller.address, paneKey: orchestrationCaller.paneKey }
        : orchestrationCompatibilityEvidence?.terminalHandle
          ? {
              handle: orchestrationCompatibilityEvidence.terminalHandle,
              paneKey:
                runtime.getTerminalPaneKey(orchestrationCompatibilityEvidence.terminalHandle) ??
                orchestrationCompatibilityEvidence.paneKey
            }
          : null
      if (
        caller &&
        db.isDispatchMessageSender({
          dispatchId: params.dispatch,
          handle: caller.handle,
          paneKey: caller.paneKey
        })
      ) {
        throw new OrchestrationError(
          'invalid_argument',
          `You cannot abandon Dispatch ${params.dispatch} while you are working it. Report to its coordinator instead. No effects were applied.`,
          { effectsApplied: false, dispatchId: params.dispatch }
        )
      }
      const abandoned = db.abandonWorkerDispatch(
        params.dispatch,
        runtime.getRuntimeId(),
        // Why: only a session caller is verified; terminal env could name anyone.
        orchestrationCaller?.address
      )
      cancelWorkerStartWait(params.dispatch)
      // Mail still queued as cards for the abandoned Dispatch must not run.
      runtime.withdrawStaleChatMail([`dispatch:${params.dispatch}`])
      if (abandoned.disposition === 'context_only') {
        if (!abandoned.alreadySettled) {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        }
        return {
          dispatchId: params.dispatch,
          state: abandoned.state,
          alreadySettled: abandoned.alreadySettled,
          stale: !abandoned.releasedCurrentTask,
          processAction: 'none',
          warning: contextOnlyAbandonWarning(abandoned),
          residualResources: []
        }
      }
      const worker = abandoned.worker
      if (abandoned.disposition === 'abandoned') {
        // Only the worker's own Dispatch settles the worker; a side task's parked mail stays.
        releaseStructuredWorkerSession(
          sessionIdFromStructuredWorkerIncarnation(
            db.getDispatchContextById(params.dispatch)?.process_incarnation
          ),
          runtime
        )
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
      }
      return {
        dispatchId: params.dispatch,
        state: worker.state,
        alreadySettled: abandoned.disposition !== 'abandoned',
        // Kept for --json readers: this attempt was no longer current, as main reported it.
        stale: abandoned.superseded || abandoned.disposition === 'already_settled',
        processAction: 'none',
        warning:
          abandoned.disposition === 'abandoned'
            ? 'Possibly-live resources were retained; no process was stopped or deleted.'
            : `The worker was already ${worker.state}; its terminal was left open and no process changed.`,
        residualResources: JSON.parse(worker.residual_resources) as unknown[]
      }
    }
  })
]

/** Every local read source (archive, chat, terminal) returns here, so one projection decorates them all. */
async function readLocalWorkerOutput(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof WorkerReadParams>,
  dispatch: NonNullable<ReturnType<OrchestrationDb['getDispatchContextById']>>,
  worker: ReturnType<OrchestrationDb['getWorkerDispatch']>
): Promise<OrchestrationWorkerReadResult> {
  const db = runtime.getOrchestrationDb()
  const terminalHandle = worker?.agent_terminal_handle ?? dispatch.assignee_handle
  if (!terminalHandle) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Worker Dispatch ${params.dispatch} has no agent terminal.`
    )
  }
  const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
  if (resource && ['releasing', 'unknown', 'released'].includes(resource.release_state)) {
    // Archive capture is not close evidence; recheck the execution host while releasing.
    let liveness: 'live' | 'unverifiable' | 'exited' =
      resource.release_state === 'released' ? 'exited' : 'unverifiable'
    if (resource.release_state === 'releasing') {
      const observed = await inspectWorkerTerminal(runtime, db, params.dispatch)
      liveness =
        observed.status === 'live'
          ? 'live'
          : observed.status === 'exited'
            ? 'exited'
            : 'unverifiable'
    }
    if (isStructuredWorkerHandle(resource.terminal_handle)) {
      // A released chat's history is read from its closed session, which needs the host after a restart.
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    }
    return readArchivedWorkerOutput({
      db,
      dispatchId: params.dispatch,
      workerState: worker?.state ?? 'unsupervised',
      resource,
      source: params.source,
      cursor: params.cursor,
      limit: params.limit,
      liveness
    })
  }
  const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
  if (!observation.exact) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Worker Dispatch ${params.dispatch} no longer resolves to its exact process.`
    )
  }
  // Read through the handle inspectWorkerTerminal proved live, including incarnation-fenced remints.
  const liveHandle = observation.terminalHandle ?? terminalHandle
  const structured = await readStructuredWorkerOutput({
    db,
    dispatchId: params.dispatch,
    workerState: worker?.state ?? 'unsupervised',
    // Reuse observation: reading a journal proves host installation, never provider-child liveness.
    liveness:
      observation.status === 'live' || observation.status === 'exited'
        ? observation.status
        : 'unverifiable',
    source: params.source,
    cursor: params.cursor,
    limit: params.limit
  })
  if (structured) {
    return structured
  }
  const output = await readExactWorkerOutput({
    runtime,
    dispatchId: params.dispatch,
    terminalHandle: liveHandle,
    workerState: worker?.state ?? 'unsupervised',
    terminalStatus:
      observation.status === 'exited'
        ? 'exited'
        : observation.status === 'unverifiable'
          ? 'unknown'
          : 'running',
    terminalLiveness:
      observation.status === 'unverifiable'
        ? 'unverifiable'
        : observation.status === 'exited'
          ? 'exited'
          : 'live',
    attachedAt: worker?.created_at ?? dispatch.dispatched_at ?? dispatch.created_at,
    source: params.source,
    cursor: params.cursor,
    limit: params.limit
  })
  const afterRead = await inspectWorkerTerminal(runtime, db, params.dispatch)
  if (!afterRead.exact) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Worker Dispatch ${params.dispatch} changed process while output was read.`
    )
  }
  return output
}
