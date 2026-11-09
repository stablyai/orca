import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerStopReceipt } from '../../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow
} from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import { remoteChatWorkerOf } from '../../../../orchestration/federation/remote-chat-worker'
import type { StructuredWorkerIdentity } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { stopStructuredWorker } from '../structured-workers/orchestration-structured-worker-lifecycle'
import { stopStructuredWorkerForRelease } from '../worker/structured-worker-release-stop'
import { captureWorkerReleaseArchive } from '../worker/worker-release-archive-capture'
import {
  isStillReleasing,
  retainedReason,
  type WorkerReleaseReceipt
} from '../worker/worker-release-completion'
import { orchestrationTimestampToMs } from '../worker/worker-output'
import { archiveSummary } from '../worker/worker-terminal-resource-presentation'
import { summarizeWorkerOutputArchive } from '../../../../orchestration/workers/archives/worker-output-archive'
import { yieldAutoReleaseToWorkingAgent } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-working-yield'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/db/orchestration-records'

/** Close a chat worker the way a local stop does; only a proven close settles. */
export async function stopRemoteChatWorker(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  chat: NonNullable<ReturnType<typeof remoteChatWorkerOf>>
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  const unknown = (reason: string, processAction: string): WorkerStopReceipt => {
    const attachment = db.markRemoteAttachmentStopUnknown(dispatchId, reason)
    return {
      dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction,
      lastError: attachment.last_error
    }
  }
  if (!chat.exact) {
    return unknown(
      'The recorded chat worker is no longer this Dispatch; nothing was closed.',
      'none'
    )
  }
  // Install the chat host after a restart, or the close cannot reach the session.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const stop = await stopStructuredWorker(chat.identity, runtime)
  if (!stop.stopped) {
    return unknown(
      stop.reason ?? 'The close was not proven.',
      stop.closeAttempted ? 'closed_agent_terminal' : 'none'
    )
  }
  const attachment = db.settleRemoteAttachmentStop(dispatchId)
  return {
    dispatchId,
    state: attachment.state,
    alreadySettled: false,
    processAction: 'closed_agent_terminal'
  }
}

/** A chat releases the way a local chat worker does: its transcript is kept, the release commits,
 *  a working agent defers an automatic one, and only then does its chat close. */
export async function releaseRemoteChatWorker(
  runtime: WorkerTerminalReleaseRuntime,
  attachment: RemoteDispatchAttachmentRow,
  identity: StructuredWorkerIdentity,
  resource: WorkerTerminalResourceRow,
  storedArchive: WorkerTerminalArchiveRow | null
): Promise<WorkerReleaseReceipt> {
  const db = runtime.getOrchestrationDb()
  const dispatchId = attachment.dispatch_id
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  let archive: Pick<
    Parameters<OrchestrationDb['commitWorkerTerminalArchiveForRelease']>[0],
    'kind' | 'content' | 'archiveSource' | 'archiveStatus'
  >
  if (storedArchive) {
    const stored = summarizeWorkerOutputArchive(storedArchive)
    archive = {
      archiveSource: stored.source,
      archiveStatus: stored.status === 'empty' ? 'empty' : 'captured'
    }
  } else {
    const capture = await captureWorkerReleaseArchive({
      db,
      resource,
      runtime,
      dispatchId,
      terminalHandle: identity.handle,
      attachedAtMs: orchestrationTimestampToMs(attachment.created_at),
      structuredWorker: identity
    })
    if ('receipt' in capture) {
      return capture.receipt
    }
    const { captured } = capture
    archive = {
      kind: captured.kind,
      content: JSON.stringify(captured.content),
      archiveSource: captured.kind === 'terminal_tail' ? 'terminal' : 'transcript',
      archiveStatus: captured.status === 'empty' ? 'empty' : 'captured'
    }
  }
  const committed = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...archive
  })
  const releasing = !isStillReleasing(committed)
    ? committed
    : !remoteChatWorkerOf(db, attachment)?.exact
      ? db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
      : yieldAutoReleaseToWorkingAgent(runtime, committed)
  if (!isStillReleasing(releasing)) {
    return {
      dispatchId,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  const released = await stopStructuredWorkerForRelease({
    structured: identity,
    dispatchId,
    resource: releasing,
    runtime,
    db,
    archiveSource: releasing.archive_source,
    archiveStatus: releasing.archive_status
  })
  if (released.state === 'released') {
    db.recordRemoteAttachmentStage({ dispatchId, stage: 'released' })
  }
  return released
}
