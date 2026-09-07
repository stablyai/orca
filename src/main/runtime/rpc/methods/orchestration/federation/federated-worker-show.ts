import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { DispatchContextRow, FederatedDispatchRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  callFederatedWorkerShow,
  exposeDispatchContext,
  exposeFederatedWorkerObservation,
  exposeWorker,
  projectFleetWorkerPage,
  resolvePinnedFederatedServer
} from '../worker/worker-observation'
import { applyFederatedFleetObservations } from './federated-fleet-snapshot'

/** Why worker-show cannot use the plain fleet projection: the push-fed agent-status snapshot
 *  only covers local panes, so a federated Dispatch got a fabricated `unverifiable` beside the
 *  execution host's real answer, and the guide makes the fleet verdict the one that decides. */
export function projectFederatedFleetWorker(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  environmentId: string
  observation: { status?: string; exactWorker: boolean; reason?: string }
}): OrchestrationFleetWorker | null {
  const fleet = projectFleetWorkerPage(args.runtime, args.db, args.dispatchId)
  if (!fleet) {
    return null
  }
  const observed = args.observation
  applyFederatedFleetObservations(
    fleet,
    {
      observations: new Map([
        [
          args.dispatchId,
          {
            // A non-exact identity can never prove either liveness or exit.
            status:
              observed.exactWorker && (observed.status === 'live' || observed.status === 'exited')
                ? observed.status
                : ('unverifiable' as const),
            exactWorker: observed.exactWorker,
            ...(observed.reason ? { reason: observed.reason } : {})
          }
        ]
      ]),
      errors: [],
      hosts: new Map([[args.dispatchId, args.environmentId]])
    },
    fleet.durable
  )
  return fleet.workers[0] ?? null
}

export async function showFederatedWorker(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  dispatch: DispatchContextRow
  federated: FederatedDispatchRow
}) {
  const { runtime, db, dispatchId } = args
  if (!db.getWorkerDispatch(dispatchId)) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Worker Dispatch ${dispatchId} has no worker record.`
    )
  }
  const observationFence = db.captureFederatedDispatchObservationFence(dispatchId)
  if (!observationFence) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Worker Dispatch ${dispatchId} has no observation projection.`
    )
  }
  const server = resolvePinnedFederatedServer(runtime, args.federated)
  runtime.ensureOrchestrationFederationRelay(args.dispatch.run_id)
  const remote = await callFederatedWorkerShow(runtime, args.federated)
  const attachment = remote.attachment
  const settlementQueued =
    attachment.state === 'succeeded' ||
    (attachment.state === 'failed' && attachment.stage === 'worker_report_queued')
  const observationProjected = db.projectFederatedDispatchObservation(observationFence, () => {
    reconcileFederatedAttachment({ db, dispatchId, remote, settlementQueued })
  })
  if (settlementQueued) {
    await runtime.syncOrchestrationFederatedDispatchAfterCurrent(dispatchId).catch(() => undefined)
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Worker Dispatch ${dispatchId} was not found after remote reconciliation.`
    )
  }
  const observation = exposeFederatedWorkerObservation(remote.observation, observationProjected)
  return {
    dispatch: exposeDispatchContext(db.getDispatchContextById(dispatchId) ?? args.dispatch),
    worker: exposeWorker(worker),
    projection: projectFederatedFleetWorker({
      runtime,
      db,
      dispatchId,
      environmentId: server.environmentId,
      observation
    }),
    server: { environmentId: server.environmentId, name: server.name },
    remoteRuntimeEpoch:
      db.getFederatedDispatch(dispatchId)?.remote_runtime_epoch ??
      (observationProjected ? remote.runtimeEpoch : null),
    terminal: observationProjected ? remote.terminal : null,
    observation
  }
}

function reconcileFederatedAttachment(args: {
  db: OrchestrationDb
  dispatchId: string
  remote: Awaited<ReturnType<typeof callFederatedWorkerShow>>
  settlementQueued: boolean
}): void {
  const { db, dispatchId, remote } = args
  const attachment = remote.attachment
  const projected = db.updateWorkerSetupEvidence({
    dispatchId,
    setupState: attachment.setup_state,
    effects: attachment.effects
  }).worker
  if (attachment.state === 'stopped' && ['stopping', 'stop_unknown'].includes(projected.state)) {
    db.reconcileFederatedWorkerStop(dispatchId)
  } else if (
    !args.settlementQueued &&
    ['ready', 'failed', 'stopped', 'start_unknown'].includes(attachment.state)
  ) {
    db.reconcileFederatedWorkerStart({
      dispatchId,
      state: attachment.state as 'ready' | 'failed' | 'stopped' | 'start_unknown',
      stage: attachment.stage,
      lastError: attachment.last_error,
      worktreeId: attachment.worktree_id,
      terminalHandle: attachment.terminal_handle,
      setupState: attachment.setup_state,
      effects: attachment.effects,
      residualResources: attachment.residualResources
    })
  }
  if (attachment.state === 'ready' && attachment.worktree_id && attachment.terminal_handle) {
    db.updateFederatedDispatchResources({
      dispatchId,
      remoteRuntimeEpoch: remote.runtimeEpoch,
      worktreeId: attachment.worktree_id,
      terminalHandle: attachment.terminal_handle
    })
  } else {
    db.updateFederatedDispatchRuntimeEpoch(dispatchId, remote.runtimeEpoch)
  }
}
