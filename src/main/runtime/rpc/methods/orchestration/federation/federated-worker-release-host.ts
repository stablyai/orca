import { describeUnconfirmedAgentStop } from '../../../../../../shared/pty-liveness-verdict'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  summarizeWorkerOutputArchive
} from '../../../../orchestration/worker-output-archive'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { readArchivedWorkerOutput } from '../worker/worker-archive-read'
import {
  archiveSummary,
  releaseUnknownRecovery,
  type WorkerReleaseReceipt
} from '../worker/worker-release-completion'
import { orchestrationTimestampToMs } from '../worker/worker-output'
import type { inspectRemoteAttachment } from './federation-attachment-observation'
import {
  classifyWorkerTerminalCloseError,
  TRANSIENT_WORKER_RELEASE_RECOVERY
} from '../worker/worker-release-close-error'

export async function readRemoteAttachmentArchive(args: {
  runtime: OrcaRuntimeService
  attachment: RemoteDispatchAttachmentRow
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
  liveness?: 'live' | 'unverifiable' | 'exited'
}) {
  const archive = args.runtime
    .getOrchestrationDb()
    .getWorkerTerminalArchive(args.attachment.dispatch_id)
  if (!archive || !args.attachment.terminal_handle) {
    return null
  }
  return readArchivedWorkerOutput({
    db: args.runtime.getOrchestrationDb(),
    dispatchId: args.attachment.dispatch_id,
    workerState: args.attachment.state,
    resource: {
      id: `remote-attachment:${args.attachment.dispatch_id}`,
      terminal_handle: args.attachment.terminal_handle,
      release_state: args.attachment.stage === 'released' ? 'released' : 'releasing'
    },
    source: args.source,
    cursor: args.cursor,
    limit: args.limit,
    liveness: args.liveness
  })
}

export async function releaseRemoteAttachment(args: {
  runtime: OrcaRuntimeService
  attachment: RemoteDispatchAttachmentRow
  observation: Awaited<ReturnType<typeof inspectRemoteAttachment>>
  mode?: 'interactive' | 'recovery'
}): Promise<WorkerReleaseReceipt & { output?: unknown }> {
  const { runtime, attachment, observation } = args
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
  const requested = db.requestRemoteAttachmentTerminalRelease(attachment.dispatch_id)
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
  const resource = requested.resource
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
  let output
  let archive
  try {
    archive = storedArchive
    if (!archive) {
      const captured = await captureWorkerOutputArchive({
        runtime,
        dispatchId: attachment.dispatch_id,
        terminalHandle: observation.terminal.handle,
        attachedAtMs: orchestrationTimestampToMs(attachment.created_at)
      })
      db.storeWorkerTerminalArchive({
        dispatchId: attachment.dispatch_id,
        resourceId: resource.id,
        kind: captured.kind,
        content: JSON.stringify(captured.content)
      })
      archive = db.getWorkerTerminalArchive(attachment.dispatch_id)
    }
    if (!archive || archive.resource_id !== resource.id) {
      throw new Error('The execution host did not commit the worker output archive.')
    }
    output = await readRemoteAttachmentArchive({ runtime, attachment, liveness })
    if (!output) {
      throw new Error('The execution host could not reopen the committed worker output archive.')
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
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId: attachment.dispatch_id,
    resourceId: resource.id,
    archiveSource: summarizeWorkerOutputArchive(archive).source,
    archiveStatus: summarizeWorkerOutputArchive(archive).status
  })
  if (releasing.ownership_state !== 'owned' || releasing.release_state !== 'releasing') {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing),
      output
    }
  }
  if (!remoteAttachmentLeaseIsCurrent(runtime, attachment, observation, releasing)) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId: attachment.dispatch_id,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained),
      output
    }
  }
  // An exited worker still owns a terminal record and tab on the host; close it before
  // reporting `closed_exited_terminal`, exactly as the local release path does.
  try {
    const close = await runtime.closeTerminal(observation.terminal.handle)
    // A host-certified exit already proved the process is gone, so a kill that stops nothing
    // is not new doubt; anything else that survives the close still is.
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
    // A close that finds nothing to close is this release's goal once the host certified the
    // exit; reporting release_unknown wedged the record and told the agent to retry the same
    // stale handle.
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
  runtime: OrcaRuntimeService,
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
