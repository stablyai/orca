import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { RemoteDispatchAttachmentRow } from '../../orchestration/types'
import { captureWorkerOutputArchive } from '../../orchestration/worker-output-archive'
import { archiveSummary } from './orchestration-worker-release-completion'
import { orchestrationTimestampToMs } from './orchestration-worker-output'

type RemoteReleaseReceipt = {
  dispatchId: string
  state: 'released' | 'already_released' | 'retained' | 'release_pending' | 'release_unknown'
  reason?: string
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: { source: string | null; status: string | null } | null
  lastError?: string
}

const activeReleaseByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<RemoteReleaseReceipt>>
>()

export function releaseRemoteAttachment(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  attachment: RemoteDispatchAttachmentRow
  mode?: 'request' | 'recovery'
}): Promise<RemoteReleaseReceipt> {
  let activeByDispatch = activeReleaseByRuntime.get(args.runtime)
  if (!activeByDispatch) {
    activeByDispatch = new Map()
    activeReleaseByRuntime.set(args.runtime, activeByDispatch)
  }
  const active = activeByDispatch.get(args.attachment.dispatch_id)
  if (active) {
    return active
  }
  const release = releaseRemoteAttachmentOnce(args).finally(() => {
    if (activeByDispatch?.get(args.attachment.dispatch_id) === release) {
      activeByDispatch.delete(args.attachment.dispatch_id)
    }
  })
  activeByDispatch.set(args.attachment.dispatch_id, release)
  return release
}

async function releaseRemoteAttachmentOnce(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  attachment: RemoteDispatchAttachmentRow
  mode?: 'request' | 'recovery'
}): Promise<RemoteReleaseReceipt> {
  const { runtime, db, attachment } = args
  const dispatchId = attachment.dispatch_id
  const currentResource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (
    args.mode === 'recovery' &&
    currentResource?.release_state === 'retained' &&
    currentResource.retained_reason === 'user_requested'
  ) {
    return {
      dispatchId,
      state: 'retained',
      reason: 'user_requested',
      processAction: 'none',
      archive: archiveSummary(currentResource)
    }
  }
  const requested = db.requestRemoteAttachmentTerminalRelease(dispatchId)
  if (requested.disposition === 'retained') {
    return {
      dispatchId,
      state: 'retained',
      reason: requested.reason,
      processAction: 'none',
      archive: archiveSummary(requested.resource)
    }
  }
  if (requested.disposition === 'already_released') {
    if (attachment.stage !== 'released') {
      markRemoteAttachmentReleased(db, attachment, requested.resource.terminal_handle)
    }
    return {
      dispatchId,
      state: 'already_released',
      processAction: 'none',
      archive: archiveSummary(requested.resource)
    }
  }
  const resource = requested.resource
  let terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>>
  try {
    terminal = await runtime.showTerminal(resource.terminal_handle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (terminalObservationProvesAbsence(reason)) {
      if (args.mode === 'recovery') {
        const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
        return {
          dispatchId,
          state: 'retained',
          reason: 'identity_unproven',
          processAction: 'none',
          archive: archiveSummary(retained)
        }
      }
      const unknown = db.markWorkerTerminalReleaseUnknown(
        resource.id,
        'The exact remote terminal is absent; whether its process exited cannot be proven.'
      )
      return {
        dispatchId,
        state: 'release_unknown',
        processAction: 'none',
        archive: archiveSummary(unknown),
        lastError: unknown.release_error ?? undefined
      }
    }
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(resource),
      lastError: reason
    }
  }
  if (
    !db.isRemoteAttachmentProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    })
  ) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }

  let archive = db.getWorkerTerminalArchive(dispatchId)
  let archiveSource = resource.archive_source as 'transcript' | 'terminal' | null
  let archiveStatus = resource.archive_status
  let capturedArchive: { kind: 'transcript_pin' | 'terminal_tail'; content: string } | undefined
  if (!archive) {
    const captured = await captureWorkerOutputArchive({
      runtime,
      dispatchId,
      terminalHandle: resource.terminal_handle,
      attachedAtMs: orchestrationTimestampToMs(attachment.created_at)
    })
    capturedArchive = { kind: captured.kind, content: JSON.stringify(captured.content) }
    archiveSource = captured.kind === 'transcript_pin' ? 'transcript' : 'terminal'
    archiveStatus = captured.status
  } else {
    archiveSource ??= archive.kind === 'transcript_pin' ? 'transcript' : 'terminal'
    archiveStatus ??= 'captured'
  }
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...capturedArchive,
    archiveSource: archiveSource ?? 'terminal',
    archiveStatus: archiveStatus === 'empty' ? 'empty' : 'captured'
  })
  archive = db.getWorkerTerminalArchive(dispatchId)
  if (
    releasing.ownership_state !== 'owned' ||
    releasing.release_state !== 'releasing' ||
    !archive
  ) {
    return {
      dispatchId,
      state: 'retained',
      reason: releasing.ownership_state === 'user_owned' ? 'user_takeover' : 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  if (
    !db.isRemoteAttachmentProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    })
  ) {
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
    await runtime.closeTerminal(resource.terminal_handle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: reason
    }
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  markRemoteAttachmentReleased(db, attachment, resource.terminal_handle)
  return {
    dispatchId,
    state: 'released',
    processAction:
      terminal.connected === false ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: archiveSummary(released)
  }
}

function markRemoteAttachmentReleased(
  db: OrchestrationDb,
  attachment: RemoteDispatchAttachmentRow,
  terminalHandle: string
): void {
  const current = db.getRemoteDispatchAttachment(attachment.dispatch_id) ?? attachment
  db.recordRemoteAttachmentStage({
    dispatchId: attachment.dispatch_id,
    stage: 'released',
    state: current.state,
    effects: [
      ...(JSON.parse(current.effects) as unknown[]),
      { kind: 'terminal', role: 'agent', action: 'released', id: terminalHandle }
    ]
  })
}

function terminalObservationProvesAbsence(reason: string): boolean {
  return /terminal_(?:handle_stale|not_found|gone)/i.test(reason)
}
