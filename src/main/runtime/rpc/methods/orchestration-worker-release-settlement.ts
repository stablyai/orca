import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  recheckProcessLiveness,
  type WorkerTerminalObservationStatus
} from './orchestration-worker-observation'
import { workerTerminalLeaseIsCurrent } from './orchestration-worker-terminal-lease'

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: 'released' | 'already_released' | 'retained' | 'release_pending' | 'release_unknown'
  reason?: WorkerTerminalRetainedReason
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

/**
 * Closes the exact leased terminal and turns the outcome into a receipt. Every unproven path lands
 * on `retained` rather than a release, and a close that refuses on incarnation, or a lease that
 * stopped being current across any await, is one of them.
 */
export async function closeAndSettleWorkerTerminalRelease(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  observationStatus: WorkerTerminalObservationStatus
  archiveSource: 'transcript' | 'terminal' | null
  archiveStatus: WorkerTerminalArchiveStatus | null
}): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource, observationStatus, archiveSource, archiveStatus } =
    args
  // closeTerminal may turn a retained, already-dead PTY into stop_unverified while trying to
  // clean up a tab that the user already removed. Freeze the exact process verdict first.
  const exactProcessWasAlreadyExited =
    observationStatus === 'exited' && (await recheckProcessLiveness(runtime, resource)) === 'exited'
  // The liveness query above yields. Re-prove the lease in the same synchronous turn that enters
  // closeTerminal so a replacement incarnation cannot be closed with the stale worker's handle.
  if (
    !workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, observationStatus === 'exited')
  ) {
    return retainWorkerTerminalRelease(db, dispatchId, resource)
  }
  try {
    const close = await runtime.closeTerminal(
      resource.terminal_handle,
      resource.process_incarnation
        ? { expectedProcessIncarnation: resource.process_incarnation }
        : {}
    )
    if (
      close.closeRefusedReason === 'incarnation_replaced' ||
      !workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, true)
    ) {
      return retainWorkerTerminalRelease(db, dispatchId, resource)
    }
    if (!close.ptyKilled) {
      if (exactProcessWasAlreadyExited) {
        return (
          settleExitedWorkerTerminalRelease({
            runtime,
            db,
            dispatchId,
            resource,
            processAction: 'closed_exited_terminal'
          }) ?? retainWorkerTerminalRelease(db, dispatchId, resource)
        )
      }
      const reason = describeUnconfirmedAgentStop(close)
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
      return {
        dispatchId,
        state: 'release_unknown',
        processAction: 'closed_agent_terminal',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: unknown.release_error ?? reason,
        recovery: inspectRecovery(dispatchId)
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // The tab acknowledgement can be lost while the addressed process dies inside close, so the
    // pre-close snapshot cannot express live -> exited. Only the post-close recheck may settle it,
    // and it answers `unverifiable` once the handle stops resolving the recorded incarnation.
    if (
      reason === 'tab_not_found' &&
      (await recheckProcessLiveness(runtime, resource)) === 'exited'
    ) {
      return (
        settleExitedWorkerTerminalRelease({
          runtime,
          db,
          dispatchId,
          resource,
          processAction: 'none'
        }) ?? retainWorkerTerminalRelease(db, dispatchId, resource)
      )
    }
    if (/disposed|not connected|unavailable/i.test(reason)) {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: reason,
        recovery:
          'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: { source: archiveSource, status: archiveStatus },
      lastError: unknown.release_error ?? reason,
      recovery: inspectRecovery(dispatchId)
    }
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction:
      observationStatus === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: summarizeWorkerTerminalArchive(released)
  }
}

/** Settles a release on a proven-exited process; null when the lease no longer proves ownership. */
function settleExitedWorkerTerminalRelease(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  processAction: 'closed_exited_terminal' | 'none'
}): WorkerReleaseReceipt | null {
  const { runtime, db, dispatchId, resource, processAction } = args
  // Re-prove the lease after close so a replacement process cannot inherit the old death proof.
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, true)) {
    return null
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction,
    archive: summarizeWorkerTerminalArchive(released)
  }
}

/** Null rather than a pair of nulls, so a receipt distinguishes "no archive" from an empty one. */
export function summarizeWorkerTerminalArchive(resource: WorkerTerminalResourceRow) {
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}

/** The one landing for unproven identity: keep the resource retained, claim no process action. */
function retainWorkerTerminalRelease(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): WorkerReleaseReceipt {
  const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
  return {
    dispatchId,
    state: 'retained',
    reason: 'identity_unproven',
    processAction: 'none',
    archive: summarizeWorkerTerminalArchive(retained)
  }
}

/** Operator instructions carried on receipts that could not settle. */
function inspectRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
}
