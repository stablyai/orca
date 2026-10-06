import type { OrchestrationDb } from '../../../../orchestration/db'
import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow
} from '../../../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  summarizeWorkerOutputArchive
} from '../../../../orchestration/worker-output-archive'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { describeUnconfirmedAgentStop } from '../../../../../../shared/pty-liveness-verdict'
import { inspectWorkerTerminal } from './worker-observation'
import { orchestrationTimestampToMs } from './worker-output'
import { archiveSummary } from './worker-terminal-resource-presentation'
import { classifyWorkerTerminalCloseError } from './worker-release-close-error'
import { workerTerminalLeaseIsCurrent } from './worker-terminal-release-lease'
import { resolveStructuredWorkerForDispatch } from '../../orchestration-structured-worker-lifecycle'
import { stopStructuredWorkerForRelease } from './structured-worker-release-stop'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'
import { releaseProvenDeadMissingWorkerTerminal } from './worker-release-missing-terminal'
import {
  releasePendingRecovery,
  releaseUnknownRecovery,
  retainedReason,
  type WorkerReleaseReceipt
} from './worker-release-receipt'

export {
  archiveSummary,
  exposeWorkerTerminalResource
} from './worker-terminal-resource-presentation'
export { releaseUnknownRecovery } from './worker-release-receipt'
export type { WorkerReleaseReceipt } from './worker-release-receipt'

type WorkerTerminalReleaseArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  mode?: 'interactive' | 'recovery'
}

type ActiveWorkerTerminalRelease = {
  promise: Promise<WorkerReleaseReceipt>
  recoveryRequested: boolean
}

const activeReleaseByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, ActiveWorkerTerminalRelease>
>()

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
    active.recoveryRequested ||= args.mode === 'recovery'
    return active.promise
  }
  const activeRelease = {
    recoveryRequested: args.mode === 'recovery'
  } as ActiveWorkerTerminalRelease
  const release = completeWorkerTerminalReleaseOnce(args)
    .then((receipt) => {
      if (activeRelease.recoveryRequested) {
        args.db.recordWorkerTerminalRecoveryAttempt(args.resource.id)
      }
      return receipt
    })
    .finally(() => {
      if (activeByResource?.get(args.resource.id) === activeRelease) {
        activeByResource.delete(args.resource.id)
      }
    })
  activeRelease.promise = release
  activeByResource.set(args.resource.id, activeRelease)
  return release
}

async function completeWorkerTerminalReleaseOnce(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  if (isStructuredWorkerHandle(resource.terminal_handle)) {
    // Observation and archive capture both read the structured host, and after a restart nothing
    // has installed it yet — the startup recovery reconciler runs exactly this path. Installing it
    // here is what lets the release see the session instead of reporting it unreadable.
    //
    // NOT yet handled, and deliberately follow-up: rebinding a restarted runtime to a structured
    // worker's redrive subscription. Until that exists, a worker that survives a restart has its
    // parked mail wait for the next arrival rather than a settle edge.
    await runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => {
      console.warn(
        '[orchestration] structured host install failed before release',
        dispatchId,
        error
      )
    })
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker || worker.agent_terminal_handle !== resource.terminal_handle) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  // The live handle to act on: the durable one, or a handle re-minted from the recorded process
  // incarnation when the durable handle went stale (inspectWorkerTerminal proved it live).
  const terminalHandle = observation.terminalHandle ?? resource.terminal_handle
  if (observation.status === 'identity_changed') {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  if (observation.status === 'missing' || observation.status === 'unattached') {
    const deadRelease = await releaseProvenDeadMissingWorkerTerminal({
      runtime,
      db,
      dispatchId,
      resource
    })
    if (deadRelease) {
      return deadRelease
    }
    if (args.mode === 'recovery') {
      // No death certificate yet: inventory may still be incomplete during startup/reconnect
      // discovery, so defer instead of guessing.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery: releasePendingRecovery()
      }
    }
    // Why: the handle resolves nowhere, but the PTY could have been re-homed after a restart —
    // claiming released would hide a live process; only an exact observation may settle it.
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
      recovery: releaseUnknownRecovery(dispatchId)
    }
  }

  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, terminalHandle)) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  const archive = db.getWorkerTerminalArchive(dispatchId)
  let archiveSource = resource.archive_source as 'transcript' | 'terminal' | null
  let archiveStatus: WorkerTerminalArchiveStatus | null = resource.archive_status
  let capturedArchive: { kind: WorkerTerminalArchiveKind; content: string } | undefined
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (!archive) {
    const captured = await captureWorkerOutputArchive({
      runtime,
      dispatchId,
      terminalHandle,
      attachedAtMs: orchestrationTimestampToMs(worker.created_at),
      structuredWorker: structured
    })
    capturedArchive = { kind: captured.kind, content: JSON.stringify(captured.content) }
    archiveSource = captured.kind === 'terminal_tail' ? 'terminal' : 'transcript'
    archiveStatus = captured.status
  } else {
    const stored = summarizeWorkerOutputArchive(archive)
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
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }

  try {
    if (structured) {
      return await stopStructuredWorkerForRelease({
        structured,
        dispatchId,
        resource,
        runtime,
        db,
        archiveSource,
        archiveStatus
      })
    }
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
        recovery: releaseUnknownRecovery(dispatchId)
      }
    }
  } catch (error) {
    const closeError = classifyWorkerTerminalCloseError(error)
    const reason = closeError.reason
    // A close that finds nothing to close is this release's goal once the host certified the
    // exit; anything else keeps the record open for recovery.
    if (!(closeError.alreadyGone && observation.status === 'exited')) {
      if (closeError.transient) {
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
        recovery: releaseUnknownRecovery(dispatchId)
      }
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
