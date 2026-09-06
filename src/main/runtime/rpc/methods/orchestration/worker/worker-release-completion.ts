import type { OrchestrationDb } from '../../../../orchestration/db'
import type {
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
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

export {
  archiveSummary,
  exposeWorkerTerminalResource
} from './worker-terminal-resource-presentation'

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
    if (args.mode === 'recovery') {
      // A close can succeed before the process crashes, leaving `releasing` durable state while
      // terminal inventory no longer resolves the handle. Only a positive host liveness verdict
      // may settle that exact incarnation; contact loss remains pending/unverifiable.
      if (resource.process_incarnation) {
        const processLiveness = await runtime.inspectTerminalProcessIncarnationLiveness(
          resource.process_incarnation,
          resource.host_scope
        )
        if (processLiveness === 'exited') {
          const reconciled = db.settleDeadWorkerTerminalRelease({
            requestingDispatchId: dispatchId,
            resourceId: resource.id,
            processIncarnation: resource.process_incarnation
          })
          if (reconciled.disposition === 'released') {
            runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
            return {
              dispatchId,
              state: 'released',
              processAction: 'closed_exited_terminal',
              archive: archiveSummary(reconciled.resource)
            }
          }
        }
      }
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

  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource)) {
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
  let capturedArchive: { kind: 'transcript_pin' | 'terminal_tail'; content: string } | undefined
  if (!archive) {
    const captured = await captureWorkerOutputArchive({
      runtime,
      dispatchId,
      terminalHandle: resource.terminal_handle,
      attachedAtMs: orchestrationTimestampToMs(worker.created_at)
    })
    capturedArchive = { kind: captured.kind, content: JSON.stringify(captured.content) }
    archiveSource = captured.kind === 'transcript_pin' ? 'transcript' : 'terminal'
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
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, releasing)) {
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
    const close = await runtime.closeTerminal(resource.terminal_handle)
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

export function releaseUnknownRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then retry worker-release with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays this release_unknown receipt. Never substitute a broad terminal close.`
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
