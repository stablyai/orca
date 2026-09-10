import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../orchestration/worker-terminal-ownership'
import { settleWorkerTerminalTabNotFoundCloseRace } from '../../orchestration/db/worker-terminal/worker-terminal-close-race'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { archiveSummary } from './orchestration-worker-terminal-resource-view'
import { releaseUnknown } from './orchestration-worker-release-receipts'
import { workerTerminalCloseReceiptProvesExit } from '../../orchestration/worker-terminal-release-proof'

export type WorkerReleaseReceipt = {
  dispatchId: string
  state:
    | 'released'
    | 'already_absent'
    | 'already_released'
    | 'retained'
    | 'release_pending'
    | 'release_unknown'
  reason?: WorkerTerminalRetainedReason
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  processVerdict?: 'live' | 'unverifiable' | 'exited'
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
  closeResponse?: { error: 'tab_not_found'; message: string }
  inventoryResponse?: { state: 'absent' | 'still_present' | 'unverifiable' }
}

export async function reconcileMissingWorkerTerminalRelease(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  mode?: 'interactive' | 'recovery'
}): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  const archive = db.getWorkerTerminalArchive(dispatchId)
  if (
    (args.mode !== 'recovery' && resource.release_state !== 'unknown') ||
    !resource.process_incarnation ||
    archive?.resource_id !== resource.id
  ) {
    if (args.mode === 'recovery') {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        processVerdict: 'unverifiable',
        archive: archiveSummary(resource),
        recovery: releaseRecovery(dispatchId)
      }
    }
    return {
      ...releaseUnknown(
        db,
        dispatchId,
        resource,
        'The recorded terminal is missing; its process state is unverifiable.'
      ),
      processVerdict: 'unverifiable'
    }
  }
  const processVerdict = await inspectProcess(runtime, resource)
  if (processVerdict === 'exited') {
    const settled = db.settleDeadWorkerTerminalRelease({
      requestingDispatchId: dispatchId,
      resourceId: resource.id,
      processIncarnation: resource.process_incarnation
    })
    if (settled.disposition === 'released') {
      runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
      return {
        dispatchId,
        state: 'released',
        processAction: 'closed_exited_terminal',
        processVerdict,
        archive: archiveSummary(settled.resource)
      }
    }
  }
  const reason =
    processVerdict === 'live'
      ? 'The recorded terminal is missing, but its exact process is live on the owning host.'
      : processVerdict === 'exited'
        ? 'The exact process exited, but its worker release identity no longer matches.'
        : 'The recorded terminal is missing, and its exact process is unverifiable on the owning host.'
  if (args.mode === 'recovery') {
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      processVerdict,
      archive: archiveSummary(resource),
      lastError: reason,
      recovery: releaseRecovery(dispatchId)
    }
  }
  return { ...releaseUnknown(db, dispatchId, resource, reason), processVerdict }
}

export async function closeWorkerTerminalOnOwningHost(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  releasing: WorkerTerminalResourceRow
  archiveSource: 'transcript' | 'terminal' | null
  archiveStatus: WorkerTerminalArchiveStatus | null
}): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource, releasing, archiveSource, archiveStatus } = args
  let close: Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>
  try {
    close = await runtime.closeTerminal(resource.terminal_handle)
    if (!close) {
      throw new Error('terminal_close_unverifiable')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/(?:session_)?tab_not_found/.test(reason)) {
      return settleWorkerTerminalTabNotFoundCloseRace({
        runtime,
        db,
        dispatchId,
        resource,
        archive: { source: archiveSource, status: archiveStatus },
        closeResponse: { error: 'tab_not_found', message: reason }
      })
    }
    if (/disposed|not connected|unavailable/i.test(reason)) {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(releasing),
        lastError: reason,
        recovery: releaseRecovery(dispatchId),
        processVerdict: 'unverifiable'
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: { source: archiveSource, status: archiveStatus },
      lastError: unknown.release_error ?? reason,
      recovery: releaseRecovery(dispatchId)
    }
  }
  const processVerdict = workerTerminalCloseReceiptProvesExit(close, resource)
    ? 'exited'
    : await inspectProcess(runtime, resource)
  if (processVerdict === 'exited') {
    const released = settleExactWorkerTerminalRelease(db, dispatchId, resource)
    if (
      released.release_state === 'released' &&
      exactReleaseIdentity(released, dispatchId, resource)
    ) {
      runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
      return {
        dispatchId,
        state: 'released',
        processAction: 'closed_agent_terminal',
        processVerdict,
        archive: archiveSummary(released)
      }
    }
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'closed_agent_terminal',
      processVerdict,
      archive: archiveSummary(released),
      lastError:
        'The exact process exited, but the worker release identity changed before settlement.',
      recovery: releaseRecovery(dispatchId)
    }
  }
  const reason =
    processVerdict === 'live'
      ? 'The agent terminal was closed but its exact process remains live on the owning host.'
      : describeUnconfirmedAgentStop(close)
  const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
  return {
    dispatchId,
    state: 'release_unknown',
    processAction: 'closed_agent_terminal',
    processVerdict,
    archive: { source: archiveSource, status: archiveStatus },
    lastError: unknown.release_error ?? reason,
    recovery: releaseRecovery(dispatchId)
  }
}

function settleExactWorkerTerminalRelease(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): WorkerTerminalResourceRow {
  return db.settleWorkerTerminalRelease({
    resourceId: resource.id,
    ownerDispatchId: dispatchId,
    processIncarnation: resource.process_incarnation ?? ''
  })
}

function exactReleaseIdentity(
  resource: WorkerTerminalResourceRow,
  dispatchId: string,
  original: WorkerTerminalResourceRow
): boolean {
  return (
    resource.owner_dispatch_id === dispatchId &&
    resource.process_incarnation !== null &&
    resource.process_incarnation === original.process_incarnation
  )
}

function inspectProcess(
  runtime: OrcaRuntimeService,
  resource: WorkerTerminalResourceRow
): Promise<'live' | 'unverifiable' | 'exited'> {
  return runtime
    .inspectTerminalProcessIncarnationLiveness(
      resource.process_incarnation ?? '',
      resource.host_scope
    )
    .catch(() => 'unverifiable' as const)
}

function releaseRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
}
