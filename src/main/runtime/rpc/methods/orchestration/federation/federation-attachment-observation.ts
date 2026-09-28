import type { RuntimeTerminalInteractiveWait } from '../../../../../../shared/runtime-types'
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
  /** The handle that actually resolved: the durable one, or a live handle re-minted from the
   *  recorded process incarnation after the durable handle went stale. Null when none resolved. */
  terminalHandle: string | null
}> {
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  if (!attachment?.terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached', terminalHandle: null }
  }
  let effectiveHandle = attachment.terminal_handle
  let terminal = await runtime.showTerminal(effectiveHandle).catch(() => null)
  if (!terminal) {
    // Why: the durable handle resolves nowhere after a renderer graph epoch bump or handle
    // invalidation, yet the recorded process incarnation may still name a live PTY. Re-mint a
    // live handle (incarnation-fenced) so federation-show, read, readOutput, stop, and release
    // act on the still-running process instead of reporting it missing — which would leak the
    // agent process tree (the federation twin of #18737 / PR #18790).
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    const processIncarnation = resource?.process_incarnation ?? attachment.process_incarnation
    const hostScope = resource?.host_scope ?? attachment.host_scope ?? null
    const reminted =
      processIncarnation && hostScope
        ? runtime.resolveTerminalHandleByProcessIncarnation?.(processIncarnation, hostScope)
        : null
    if (reminted) {
      const remintedTerminal = await runtime.showTerminal(reminted).catch(() => null)
      if (remintedTerminal) {
        effectiveHandle = reminted
        terminal = remintedTerminal
      }
    }
  }
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing', terminalHandle: null }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(effectiveHandle),
    processIncarnation: runtime.getTerminalProcessIncarnation(effectiveHandle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed', terminalHandle: effectiveHandle }
  }
  // Why: transport loss clears `connected` for every remote PTY; only the execution host can certify exit.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(effectiveHandle) ?? null
  if (verdict?.status === 'unverifiable') {
    return {
      terminal,
      exact,
      status: 'unverifiable',
      reason: verdict.reason,
      agentWait,
      terminalHandle: effectiveHandle
    }
  }
  if (!verdict) {
    // Why: the verdict register only fills on the first inventory sweep or exit frame, so a PTY
    // this host just spawned has none for minutes and every fleet row read host_indeterminate.
    // The host owns a connected local pane, so its own connected flag is host evidence of life,
    // exactly as worker-show reads it. Nothing weaker earns a claim: a disconnected pane or an
    // SSH-scoped one (contact, not the process) stays unverifiable, never `exited`.
    const currentHostScope = runtime.getOrchestrationDispatchAuthority?.(
      effectiveHandle
    )?.hostScope
    const persistedHostScope = parseWorkerTerminalHostScope(
      db.getWorkerTerminalResourceByOwner(dispatchId)?.host_scope ?? attachment.host_scope ?? null
    )
    const provenLocal =
      currentHostScope !== undefined &&
      currentHostScope.kind !== 'ssh' &&
      persistedHostScope?.kind !== 'ssh'
    if (provenLocal && terminal.connected !== false) {
      return { terminal, exact, status: 'live', agentWait, terminalHandle: effectiveHandle }
    }
    return {
      terminal,
      exact,
      status: 'unverifiable',
      reason: 'missing_liveness_verdict',
      agentWait,
      terminalHandle: effectiveHandle
    }
  }
  if (verdict.status === 'exited') {
    return { terminal, exact, status: 'exited', agentWait, terminalHandle: effectiveHandle }
  }
  return { terminal, exact, status: 'live', agentWait, terminalHandle: effectiveHandle }
}
