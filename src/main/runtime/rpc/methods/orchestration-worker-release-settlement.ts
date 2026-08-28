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
      const settled = exactProcessWasAlreadyExited
        ? settleExitedWorkerTerminalRelease({
            runtime,
            db,
            dispatchId,
            resource,
            processAction: 'closed_exited_terminal'
          })
        : null
      if (settled) {
        return settled
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
    const settled =
      exactProcessWasAlreadyExited &&
      reason === 'tab_not_found' &&
      (await recheckProcessLiveness(runtime, resource)) === 'exited'
        ? settleExitedWorkerTerminalRelease({
            runtime,
            db,
            dispatchId,
            resource,
            processAction: 'none'
          })
        : null
    if (settled) {
      return settled
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

export function summarizeWorkerTerminalArchive(resource: WorkerTerminalResourceRow) {
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}

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

function inspectRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
}
