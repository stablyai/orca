import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import {
  releaseCommitFieldsForCapturedArchive,
  releaseCommitFieldsForStoredArchive
} from '../../../../../orchestration/workers/archives/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { describeUnconfirmedAgentStop } from '../../../../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { inspectWorkerTerminal } from '../observation/worker-observation'
import { orchestrationTimestampToMs } from '../output/worker-output'
import { archiveSummary, receiptForUnchangedRelease } from './worker-terminal-resource-presentation'
import { classifyWorkerTerminalCloseError } from './worker-release-close-error'
import { workerTerminalLeaseIsCurrent } from './worker-terminal-release-lease'
import { resolveStructuredWorkerForDispatch } from '../../structured-workers/orchestration-structured-worker-lifecycle'
import { stopStructuredWorkerForRelease } from './structured-worker-release-stop'
import { isStructuredWorkerHandle } from '../../../../../../../shared/orchestration/workers/structured-worker-handle'
import { captureWorkerReleaseArchive } from './worker-release-archive-capture'
import {
  readRequestedWorkerReleaseState,
  settleProvenExitedWorkerTerminal
} from './worker-release-proven-exit'
import { WorkerTerminalReleaseSingleFlight } from './worker-terminal-release-single-flight'
import { releaseUnknownRecovery } from './worker-release-unknown-recovery'
import { yieldAutoReleaseToWorkingAgent } from '../../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-working-yield'
import { closeWorkerBoundTerminals } from './worker-bound-terminal-close'

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
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  mode?: 'interactive' | 'recovery'
  /** Set when the worker reopens right after, so what it opened stays. */
  keepBound?: boolean
}

const localReleases = new WorkerTerminalReleaseSingleFlight<WorkerReleaseReceipt>()

// Shared RPC/recovery completion: prove exact identity, archive output, close only its terminal, then settle.
export function completeWorkerTerminalRelease(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  // Keyed by custody too: a successor's release never joins, or answers for, its predecessor's.
  const key = `${args.resource.id}\u0000${args.dispatchId}`
  let leads = false
  const shared = localReleases.run(args.runtime, key, args.mode, (active) => {
    leads = true
    return completeWorkerTerminalReleaseOnce(args).then(async (receipt) => {
      if (active.recoveryRequested) {
        // Bookkeeping for this custody only: a transfer during the proof leaves the new owner's row alone.
        args.db.recordWorkerTerminalRecoveryAttempt(args.resource.id, args.dispatchId)
      }
      if (receipt.state === 'released' && !args.keepBound) {
        await closeWorkerBoundTerminals(args.runtime, args.db, args.resource.origin_dispatch_id)
      }
      return receipt
    })
  })
  if (leads) {
    return shared
  }
  // A joined call shares the one proof and completion, but only the call that made the transition reports it.
  return shared.then((receipt) =>
    receipt.state === 'released'
      ? { ...receipt, state: 'already_released', processAction: 'none' }
      : receipt
  )
}

async function completeWorkerTerminalReleaseOnce(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  if (isStructuredWorkerHandle(resource.terminal_handle)) {
    // Install the structured host after restart before observation/archive reads.
    // Follow-up: restore redrive subscriptions too; until then parked mail waits for its next arrival.
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
    return retainUnproven(db, dispatchId, resource.id)
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  // Use inspectWorkerTerminal's proven live handle, including incarnation-fenced remints.
  const terminalHandle = observation.terminalHandle ?? resource.terminal_handle
  if (observation.status === 'identity_changed') {
    return retainUnproven(db, dispatchId, resource.id)
  }
  if (observation.status === 'missing' || observation.status === 'unattached') {
    // After remint fails, proven incarnation death settles before recovery deferral; never leave dead workers release_pending.
    const exited = await settleProvenExitedWorkerTerminal({ runtime, db, dispatchId, resource })
    if (exited) {
      return {
        dispatchId,
        state: 'released',
        processAction: 'none',
        archive: archiveSummary(exited)
      }
    }
    // A keep-open, transfer or another release that landed during the proof wins; report it rather than an unresolved release.
    const settled = readRequestedWorkerReleaseState(db, dispatchId, resource.id)
    if (settled) {
      return settled
    }
    if (args.mode === 'recovery') {
      // Incomplete startup/reconnect inventory proves no death; defer.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
      }
    }
    // An unresolved handle may be re-homed; require exact observation before claiming release.
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      'The recorded terminal no longer resolves; whether its process is gone cannot be proven.',
      dispatchId
    )
    if (unknown.release_state !== 'unknown') {
      return receiptForUnchangedRelease(dispatchId, unknown)
    }
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: unknown.release_error ?? undefined,
      recovery: releaseUnknownRecovery(dispatchId)
    }
  }

  // The observation awaited: a retain and reuse may have handed the row on. Nothing below, from the resume
  // capture to the close, may act on another dispatch's custody.
  const current = db.getWorkerTerminalResource(resource.id)
  if (current?.owner_dispatch_id !== dispatchId) {
    return receiptForUnchangedRelease(dispatchId, current)
  }
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource, terminalHandle)) {
    return retainUnproven(db, dispatchId, resource.id)
  }
  const archive = db.getWorkerTerminalArchive(dispatchId)
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  let recorded: { kind: WorkerTerminalArchiveKind; content: string } | undefined
  let stored = archive ? releaseCommitFieldsForStoredArchive(archive) : undefined
  if (!stored) {
    const capture = captureWorkerReleaseArchive({
      db,
      resource,
      runtime,
      dispatchId,
      terminalHandle,
      attachedAtMs: orchestrationTimestampToMs(worker.created_at),
      structuredWorker: structured
    })
    if ('receipt' in capture) {
      return capture.receipt
    }
    const { kind, content, ...fields } = releaseCommitFieldsForCapturedArchive(capture.captured)
    recorded = { kind, content }
    stored = fields
  }
  const archiveSource = stored.archiveSource
  const archiveStatus = stored.archiveStatus
  const committed = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...recorded,
    archiveSource,
    archiveStatus
  })
  const releasing = !isStillReleasing(committed, dispatchId)
    ? committed
    : !workerTerminalLeaseIsCurrent(runtime, db, dispatchId, committed, terminalHandle)
      ? db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven', dispatchId)
      : yieldAutoReleaseToWorkingAgent(runtime, committed)
  if (!isStillReleasing(releasing, dispatchId)) {
    return receiptForUnchangedRelease(dispatchId, releasing)
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
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason, dispatchId)
      if (unknown.release_state !== 'unknown') {
        return receiptForUnchangedRelease(dispatchId, unknown, 'closed_agent_terminal')
      }
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
    // After certified exit, absent close targets mean success; other failures retain recovery intent.
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
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason, dispatchId)
      if (unknown.release_state !== 'unknown') {
        return receiptForUnchangedRelease(dispatchId, unknown)
      }
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
  const closed =
    observation.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal'
  const released = db.settleWorkerTerminalRelease(resource.id, dispatchId)
  if (released.owner_dispatch_id !== dispatchId || released.release_state !== 'released') {
    // A Keep open that won during the close, or another custody: no transition here, so nothing to announce.
    return receiptForUnchangedRelease(dispatchId, released, closed)
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return { dispatchId, state: 'released', processAction: closed, archive: archiveSummary(released) }
}

function retainUnproven(
  db: OrchestrationDb,
  dispatchId: string,
  resourceId: string
): WorkerReleaseReceipt {
  return receiptForUnchangedRelease(
    dispatchId,
    db.revertWorkerTerminalReleaseToRetained(resourceId, 'identity_unproven', dispatchId)
  )
}

function isStillReleasing(resource: WorkerTerminalResourceRow, dispatchId: string): boolean {
  return (
    resource.owner_dispatch_id === dispatchId &&
    resource.ownership_state === 'owned' &&
    resource.release_state === 'releasing'
  )
}
