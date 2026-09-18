import type { RuntimeTerminalInteractiveWait } from '../../../../../../shared/runtime-types'
import {
  classifyTerminalProcessInspectionFailure,
  isOwnerProvenTerminalAbsence
} from '../../../../../../shared/terminal-process-inspection'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseWorkerTerminalHostScope } from '../../../../orchestration/worker-terminal-process-liveness'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'

export function requireHomeAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  callerFingerprint: string | undefined
): RemoteDispatchAttachmentRow {
  const attachment = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (!attachment || attachment.home_peer_fingerprint !== callerFingerprint) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${dispatchId} was not found for this Run home.`
    )
  }
  return attachment
}

export async function inspectRemoteAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  /** Set with `unverifiable`; names what we lost contact with. */
  reason?: string
  /** Set only on a proven-exact attachment parked on a prompt that needs a human. */
  agentWait?: RuntimeTerminalInteractiveWait | null
}> {
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  if (!attachment?.terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' }
  }
  let showTerminalFailure: unknown
  const terminal = await runtime
    .showTerminal(attachment.terminal_handle)
    .catch((error: unknown) => {
      showTerminalFailure = error
      return null
    })
  if (!terminal) {
    // O4: every showTerminal rejection used to collapse to 'missing' here -- the owner-proven-absence
    // word `federationShow` ships to the Run home -- so a transport timeout or a stale local handle
    // read as this host certifying the terminal gone. Same gate as inspectWorkerTerminal (O1/O2):
    // only a resolved null or the owner's own `terminal_gone` is absence; the rest is lost contact.
    if (isOwnerProvenTerminalAbsence(showTerminalFailure)) {
      return { terminal: null, exact: false, status: 'missing' }
    }
    return {
      terminal: null,
      exact: false,
      status: 'unverifiable',
      reason:
        classifyTerminalProcessInspectionFailure(showTerminalFailure) ??
        'unclassified_inspection_failure'
    }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(attachment.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(attachment.terminal_handle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed' }
  }
  // Why: transport loss clears `connected` for every remote PTY; only the execution host can certify exit.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(attachment.terminal_handle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable', reason: verdict.reason, agentWait }
  }
  if (!verdict) {
    // Why: the verdict register only fills on the first inventory sweep or exit frame, so a PTY
    // this host just spawned has none for minutes and every fleet row read host_indeterminate.
    // The host owns a connected local pane, so its own connected flag is host evidence of life,
    // exactly as worker-show reads it. Nothing weaker earns a claim: a disconnected pane or an
    // SSH-scoped one (contact, not the process) stays unverifiable, never `exited`.
    const currentHostScope = runtime.getOrchestrationDispatchAuthority?.(
      attachment.terminal_handle
    )?.hostScope
    const persistedHostScope = parseWorkerTerminalHostScope(
      db.getWorkerTerminalResourceByOwner(dispatchId)?.host_scope ?? null
    )
    const provenLocal =
      currentHostScope !== undefined &&
      currentHostScope.kind !== 'ssh' &&
      persistedHostScope?.kind !== 'ssh'
    if (provenLocal && terminal.connected !== false) {
      return { terminal, exact, status: 'live', agentWait }
    }
    return {
      terminal,
      exact,
      status: 'unverifiable',
      reason: 'missing_liveness_verdict',
      agentWait
    }
  }
  if (verdict.status === 'exited') {
    return { terminal, exact, status: 'exited', agentWait }
  }
  return { terminal, exact, status: 'live', agentWait }
}
