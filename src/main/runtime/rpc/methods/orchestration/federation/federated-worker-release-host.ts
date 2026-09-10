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
import {
  projectArchivedOutputLiveness,
  readRemoteAttachmentArchive
} from './federated-worker-output-archive'
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
import { workerTerminalCloseReceiptProvesExit } from '../../../../orchestration/worker-terminal-release-proof'

export { readRemoteAttachmentArchive } from './federated-worker-output-archive'
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
  try {
    const close = await runtime.closeTerminal(observation.terminal.handle)
    const receiptProvesExit = workerTerminalCloseReceiptProvesExit(close, resource)
    const exactProcessVerdict =
      observation.status === 'exited' || receiptProvesExit
        ? 'exited'
        : await runtime
            .inspectTerminalProcessIncarnationLiveness(
              resource.process_incarnation ?? '',
              resource.host_scope
            )
            .catch(() => 'unverifiable' as const)
    if (exactProcessVerdict !== 'exited') {
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
  const released = db.settleWorkerTerminalRelease({
    resourceId: resource.id,
    ownerDispatchId: attachment.dispatch_id,
    processIncarnation: resource.process_incarnation ?? ''
  })
  if (
    released.release_state !== 'released' ||
    released.owner_dispatch_id !== attachment.dispatch_id ||
    released.process_incarnation !== resource.process_incarnation
  ) {
    return {
      dispatchId: attachment.dispatch_id,
      state: 'release_unknown',
      processAction: 'none',
      lastError:
        'The exact process exited, but the worker release identity changed before settlement.',
      recovery: releaseUnknownRecovery(attachment.dispatch_id),
      archive: archiveSummary(released),
      output: projectArchivedOutputLiveness(output, 'unverifiable')
    }
  }
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
