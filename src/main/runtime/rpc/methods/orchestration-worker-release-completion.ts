import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  type WorkerTerminalTailArchive
} from '../../orchestration/worker-output-archive'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { inspectWorkerTerminal } from './orchestration-worker-observation'
import { orchestrationTimestampToMs } from './orchestration-worker-output'

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: 'released' | 'already_released' | 'retained' | 'release_pending' | 'release_unknown'
  reason?: WorkerTerminalRetainedReason
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

type WorkerTerminalReleaseArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  mode?: 'interactive' | 'recovery'
}

const activeReleaseByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<WorkerReleaseReceipt>>
>()

export function exposeWorkerTerminalResource(resource: WorkerTerminalResourceRow): {
  id: string
  ownershipState: string
  releaseState: string
  retainedReason: string | null
  terminalHandle: string
  worktreeId: string | null
  originDispatchId: string
  ownerDispatchId: string
  releaseRequestedAt: string | null
  releaseCompletedAt: string | null
  releaseError: string | null
  archive: { source: string | null; status: string | null }
} {
  return {
    id: resource.id,
    ownershipState: resource.ownership_state,
    releaseState: resource.release_state,
    retainedReason: resource.retained_reason,
    terminalHandle: resource.terminal_handle,
    worktreeId: resource.worktree_id,
    originDispatchId: resource.origin_dispatch_id,
    ownerDispatchId: resource.owner_dispatch_id,
    releaseRequestedAt: resource.release_requested_at,
    releaseCompletedAt: resource.release_completed_at,
    releaseError: resource.release_error,
    archive: { source: resource.archive_source, status: resource.archive_status }
  }
}

export function archiveSummary(
  resource: WorkerTerminalResourceRow | null
): { source: string | null; status: string | null } | null {
  if (!resource) {
    return null
  }
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}

// Completes a durably requested release: re-prove exact identity, freeze output, close only the
// exact agent terminal, settle. Shared between the RPC method and the startup reconciler.
export function completeWorkerTerminalRelease(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  let activeByResource = activeReleaseByRuntime.get(args.runtime)
  if (!activeByResource) {
    activeByResource = new Map()
    activeReleaseByRuntime.set(args.runtime, activeByResource)
  }
  const active = activeByResource.get(args.resource.id)
  if (active) {
    return active
  }
  const release = completeWorkerTerminalReleaseOnce(args).finally(() => {
    if (activeByResource?.get(args.resource.id) === release) {
      activeByResource.delete(args.resource.id)
    }
  })
  activeByResource.set(args.resource.id, release)
  return release
}

/** Settle a durably-requested release once: a provably gone worker settles released or release_unknown before the lease check, never falsely retained. */
async function completeWorkerTerminalReleaseOnce(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker || worker.agent_terminal_handle !== resource.terminal_handle) {
    return retainWithUnprovenIdentity(dispatchId, db, resource.id)
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  // The live handle to act on: the durable one, or a handle re-minted from the recorded process
  // incarnation when the durable handle went stale (inspectWorkerTerminal proved it live).
  const terminalHandle = observation.terminalHandle ?? resource.terminal_handle
  if (observation.status === 'identity_changed') {
    return retainWithUnprovenIdentity(dispatchId, db, resource.id)
  }
  if (observation.status === 'missing' || observation.status === 'unattached') {
    if (args.mode === 'recovery') {
      // Inventory may still be incomplete during startup/reconnect discovery; defer.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
      }
    }
    // Re-resolution by process incarnation (inspectWorkerTerminal) already failed, so no live PTY
    // carries this worker's exact incarnation. If that incarnation is provably gone, settle
    // released; otherwise the process may have been re-homed and only an exact observation may
    // settle it — concede release_unknown rather than hide, or guess at, a live process.
    if (
      resource.process_incarnation &&
      (await runtime.inspectTerminalProcessIncarnationLiveness(
        resource.process_incarnation,
        resource.host_scope
      )) === 'exited'
    ) {
      const settled = db.settleWorkerTerminalRelease(resource.id)
      runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
      return {
        dispatchId,
        state: 'released',
        processAction: 'none',
        archive: archiveSummary(settled)
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      'The recorded terminal no longer resolves; whether its process is gone cannot be proven.'
    )
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: unknown.release_error ?? undefined,
      recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  }

  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, terminalHandle)) {
    return retainWithUnprovenIdentity(dispatchId, db, resource.id)
  }

  const archive = db.getWorkerTerminalArchive(dispatchId)
  let archiveSource = resource.archive_source as 'transcript' | 'terminal' | null
  let archiveStatus: WorkerTerminalArchiveStatus | null = resource.archive_status
  let capturedArchive: { kind: 'transcript_pin' | 'terminal_tail'; content: string } | undefined
  if (!archive) {
    const captured = await captureWorkerOutputArchive({
      runtime,
      dispatchId,
      terminalHandle,
      attachedAtMs: orchestrationTimestampToMs(worker.created_at)
    })
    capturedArchive = { kind: captured.kind, content: JSON.stringify(captured.content) }
    archiveSource = captured.kind === 'transcript_pin' ? 'transcript' : 'terminal'
    archiveStatus = captured.status
  } else {
    const stored = summarizeStoredArchive(archive)
    archiveSource ??= stored.source
    archiveStatus ??= stored.status
  }
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...capturedArchive,
    archiveSource,
    archiveStatus: archiveStatus === 'empty' ? 'empty' : 'captured'
  })
  if (releasing.ownership_state !== 'owned' || releasing.release_state !== 'releasing') {
    return {
      dispatchId,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, releasing, terminalHandle)) {
    return retainWithUnprovenIdentity(dispatchId, db, resource.id)
  }

  try {
    const close = await runtime.closeTerminal(terminalHandle)
    if (!close.ptyKilled) {
      const reason = describeUnconfirmedAgentStop(close)
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
      return {
        dispatchId,
        state: 'release_unknown',
        processAction: 'closed_agent_terminal',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: unknown.release_error ?? reason,
        recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/disposed|not connected|unavailable/i.test(reason)) {
      // Durable intent exists; the owning endpoint is temporarily unreachable. Recovery retries.
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
      recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction:
      observation.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: archiveSummary(released)
  }
}

/** Revert a release to retained when the worker identity cannot be re-proven — never act on a terminal we cannot fence to this exact worker. */
function retainWithUnprovenIdentity(
  dispatchId: string,
  db: OrchestrationDb,
  resourceId: string
): WorkerReleaseReceipt {
  const retained = db.revertWorkerTerminalReleaseToRetained(resourceId, 'identity_unproven')
  return {
    dispatchId,
    state: 'retained',
    reason: 'identity_unproven',
    processAction: 'none',
    archive: archiveSummary(retained)
  }
}

/** Does this dispatch still hold the live lease? Probes the possibly re-minted live handle while the durable identity stays fenced to the recorded terminal_handle. */
function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  terminalHandle: string = resource.terminal_handle
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  // The runtime probes address the live handle (possibly re-minted from the recorded process
  // incarnation after the durable handle went stale), while the durable identity stays fenced to
  // the recorded terminal_handle.
  const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    authority &&
    resource.host_scope === JSON.stringify(authority.hostScope) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(terminalHandle),
      processIncarnation: runtime.getTerminalProcessIncarnation(terminalHandle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

function summarizeStoredArchive(archive: WorkerTerminalArchiveRow): {
  source: 'transcript' | 'terminal'
  status: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
} {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty = content.lines.every((line) => line.trim() === '')
  return { source: 'terminal', status: empty ? 'empty' : 'captured' }
}

function retainedReason(resource: WorkerTerminalResourceRow): WorkerTerminalRetainedReason {
  if (resource.retained_reason) {
    return resource.retained_reason as WorkerTerminalRetainedReason
  }
  if (resource.ownership_state === 'user_owned') {
    return 'user_takeover'
  }
  return 'identity_unproven'
}
