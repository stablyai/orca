import { describeUnconfirmedAgentStop } from '../../../../../../shared/pty-liveness-verdict'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  releaseCommitFieldsForCapturedArchive,
  releaseCommitFieldsForStoredArchive,
  summarizeWorkerOutputArchive
} from '../../../../orchestration/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { readRemoteAttachmentArchive } from './remote-attachment-archive-read'
import { WorkerTerminalReleaseSingleFlight } from '../worker/worker-terminal-release-single-flight'
import { yieldAutoReleaseToWorkingAgent } from '../../../../orchestration/worker-terminal-auto-release-working-yield'
import { archiveSummary } from '../worker/worker-terminal-resource-presentation'
import {
  releaseUnknownRecovery,
  type WorkerReleaseReceipt
} from '../worker/worker-release-completion'
import { orchestrationTimestampToMs } from '../worker/worker-output'
import type { inspectRemoteAttachment } from './federation-attachment-observation'
import {
  classifyWorkerTerminalCloseError,
  TRANSIENT_WORKER_RELEASE_RECOVERY
} from '../worker/worker-release-close-error'

type RemoteAttachmentReleaseArgs = {
  runtime: WorkerTerminalReleaseRuntime
  attachment: RemoteDispatchAttachmentRow
  observation: Awaited<ReturnType<typeof inspectRemoteAttachment>>
  mode?: 'interactive' | 'recovery'
}

type RemoteReleaseReceipt = WorkerReleaseReceipt & { output?: unknown }

const remoteReleases = new WorkerTerminalReleaseSingleFlight<RemoteReleaseReceipt>()

/** Each caller records its own request first, so a release joining the host timer's close still clears the deadline. */
export async function releaseRemoteAttachment(
  args: RemoteAttachmentReleaseArgs
): Promise<RemoteReleaseReceipt> {
  const requested = await requestRemoteAttachmentRelease(args)
  if ('state' in requested) {
    return requested
  }
  return remoteReleases.run(args.runtime, args.attachment.dispatch_id, args.mode, () =>
    completeRemoteAttachmentRelease(args, requested.resource, requested.storedArchive)
  )
}

async function requestRemoteAttachmentRelease(
  args: RemoteAttachmentReleaseArgs
): Promise<
  | RemoteReleaseReceipt
  | { resource: WorkerTerminalResourceRow; storedArchive: WorkerTerminalArchiveRow | null }
> {
  const { runtime, attachment } = args
  const db = runtime.getOrchestrationDb()
  let storedArchive
  try {
    storedArchive = db.getWorkerTerminalArchive(attachment.dispatch_id)
  } catch (error) {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      processAction: 'none',
      archive: null,
      lastError: error instanceof Error ? error.message : String(error)
    }
  }
  if (attachment.stage === 'released') {
    const archived = await readRemoteAttachmentArchive({
      runtime,
      attachment,
      liveness: 'exited'
    })
    return {
      dispatchId: attachment.dispatch_id,
      state: 'already_released',
      processAction: 'none',
      archive: storedArchive ? summarizeWorkerOutputArchive(storedArchive) : null,
      ...(archived ? { output: archived } : {})
    }
  }
  const requested = db.requestRemoteAttachmentTerminalRelease(attachment.dispatch_id, args.mode)
  if (requested.disposition === 'already_released') {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'already_released',
      processAction: 'none',
      archive: archiveSummary(requested.resource)
    }
  }
  if (requested.disposition === 'retained') {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: requested.reason,
      processAction: 'none',
      archive: archiveSummary(requested.resource)
    }
  }
  return { resource: requested.resource, storedArchive: storedArchive ?? null }
}

async function completeRemoteAttachmentRelease(
  args: RemoteAttachmentReleaseArgs,
  resource: WorkerTerminalResourceRow,
  storedArchive: WorkerTerminalArchiveRow | null
): Promise<RemoteReleaseReceipt> {
  const { runtime, attachment, observation } = args
  const db = runtime.getOrchestrationDb()
  if (!observation.exact || !observation.terminal) {
    if (
      args.mode === 'recovery' &&
      (observation.status === 'missing' || observation.status === 'unattached')
    ) {
      return {
        dispatchId: attachment.dispatch_id,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
      }
    }
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    const output = storedArchive
      ? await readRemoteAttachmentArchive({
          runtime,
          attachment,
          liveness: observation.status === 'exited' ? 'exited' : 'unverifiable'
        })
      : null
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      lastError: `The execution host reports ${observation.status}; no terminal was closed.`,
      archive: archiveSummary(retained),
      ...(output ? { output } : {})
    }
  }
  const liveness =
    observation.status === 'unverifiable'
      ? 'unverifiable'
      : observation.status === 'exited'
        ? 'exited'
        : 'live'
  let committed
  let output
  try {
    const archive = storedArchive
      ? releaseCommitFieldsForStoredArchive(storedArchive)
      : releaseCommitFieldsForCapturedArchive(
          await captureWorkerOutputArchive({
            runtime,
            dispatchId: attachment.dispatch_id,
            terminalHandle: observation.terminal.handle,
            attachedAtMs: orchestrationTimestampToMs(attachment.created_at)
          })
        )
    // Publish the archive only if the request still stands; a retain during capture keeps live output readable.
    committed = db.commitWorkerTerminalArchiveForRelease({
      dispatchId: attachment.dispatch_id,
      resourceId: resource.id,
      ...archive
    })
    if (isStillReleasing(committed)) {
      output = await readRemoteAttachmentArchive({ runtime, attachment, liveness })
      if (!output) {
        throw new Error('The execution host could not reopen the committed worker output archive.')
      }
    }
  } catch (error) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained),
      lastError: error instanceof Error ? error.message : String(error)
    }
  }
  // Decide on the current row: a release that joined during the archive read may have cleared the deadline.
  const current = db.getWorkerTerminalResource(resource.id) ?? committed
  const releasing = !isStillReleasing(current)
    ? current
    : !remoteAttachmentLeaseIsCurrent(runtime, attachment, observation, current)
      ? db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
      : yieldAutoReleaseToWorkingAgent(runtime, current)
  if (!isStillReleasing(releasing) || !output) {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  // Close the exited worker's remaining record/tab before reporting closed_exited_terminal, as local release does.
  try {
    const close = await runtime.closeTerminal(observation.terminal.handle)
    // A host-certified exit survives a no-op kill; other state surviving close remains uncertain.
    if (!close.ptyKilled && observation.status !== 'exited') {
      const reason = describeUnconfirmedAgentStop(close)
      return {
        dispatchId: attachment.dispatch_id,
        state: 'release_unknown',
        processAction: 'closed_agent_terminal',
        lastError: reason,
        recovery: releaseUnknownRecovery(attachment.dispatch_id),
        archive: archiveSummary(db.markWorkerTerminalReleaseUnknown(resource.id, reason)),
        output: projectArchivedOutputLiveness(
          output,
          close.ptyStopVerdict === 'live' ? 'live' : 'unverifiable'
        )
      }
    }
  } catch (error) {
    const closeError = classifyWorkerTerminalCloseError(error)
    // After certified exit, nothing-left-to-close is success; release_unknown would wedge retries on a stale handle.
    if (!(closeError.alreadyGone && observation.status === 'exited')) {
      return {
        dispatchId: attachment.dispatch_id,
        state: closeError.transient ? 'release_pending' : 'release_unknown',
        processAction: 'none',
        lastError: closeError.reason,
        recovery: closeError.transient
          ? TRANSIENT_WORKER_RELEASE_RECOVERY
          : releaseUnknownRecovery(attachment.dispatch_id),
        archive: archiveSummary(
          closeError.transient
            ? releasing
            : db.markWorkerTerminalReleaseUnknown(resource.id, closeError.reason)
        ),
        output: projectArchivedOutputLiveness(output, 'unverifiable')
      }
    }
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  db.recordRemoteAttachmentStage({
    dispatchId: attachment.dispatch_id,
    stage: 'released'
  })
  return {
    dispatchId: attachment.dispatch_id,
    state: 'released',
    processAction:
      observation.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: archiveSummary(released),
    output: projectArchivedOutputLiveness(output, 'exited')
  }
}

function remoteAttachmentLeaseIsCurrent(
  runtime: WorkerTerminalReleaseRuntime,
  attachment: RemoteDispatchAttachmentRow,
  observation: Awaited<ReturnType<typeof inspectRemoteAttachment>>,
  resource: WorkerTerminalResourceRow
): boolean {
  const db = runtime.getOrchestrationDb()
  return Boolean(
    observation.exact &&
    observation.terminal?.handle === resource.terminal_handle &&
    attachment.terminal_handle === resource.terminal_handle &&
    resource.owner_dispatch_id === attachment.dispatch_id &&
    resource.ownership_state === 'owned' &&
    db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
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

function projectArchivedOutputLiveness<
  T extends { status: { terminal: string; liveness: string } }
>(output: T, liveness: 'live' | 'unverifiable' | 'exited'): T {
  return {
    ...output,
    status: {
      ...output.status,
      terminal: liveness === 'live' ? 'running' : liveness === 'exited' ? 'exited' : 'unknown',
      liveness
    }
  }
}

function isStillReleasing(resource: WorkerTerminalResourceRow): boolean {
  return resource.ownership_state === 'owned' && resource.release_state === 'releasing'
}
