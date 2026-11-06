import type { RuntimeTerminalInteractiveWait } from '../../../../../../shared/runtime-types'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { parseWorkerTerminalHostScope } from '../../../../../../shared/worker-terminal-host-scope'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import { orchestrationTimestampToMs } from '../worker/worker-output'

export function requireHomeAttachment(
  runtime: WorkerTerminalReleaseRuntime,
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
  runtime: WorkerTerminalReleaseRuntime,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<WorkerTerminalReleaseRuntime['showTerminal']>> | null
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
  const terminal = await runtime.showTerminal(attachment.terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(attachment.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(attachment.terminal_handle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed' }
  }
  // Transport loss clears connected on every remote PTY; only its execution host can prove exit.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(attachment.terminal_handle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable', reason: verdict.reason, agentWait }
  }
  if (!verdict) {
    // New local PTYs lack register verdicts until inventory arrives; host-owned connected state can prove life.
    // Disconnected or SSH-scoped contact still proves neither life nor exit.
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

/** The fleet and show verdict: the terminal's, upgraded to `exited` only on this host's proof. */
export async function observeRemoteAttachmentLiveness(
  runtime: WorkerTerminalReleaseRuntime,
  dispatchId: string
): Promise<Awaited<ReturnType<typeof inspectRemoteAttachment>>> {
  const observation = await inspectRemoteAttachment(runtime, dispatchId)
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  const incarnation = attachment?.process_incarnation
  if (!attachment?.terminal_handle || !incarnation) {
    return observation
  }
  if (
    (observation.status === 'missing' || observation.status === 'identity_changed') &&
    // Legacy runtimeId:ptyId:generation fences never match the process table, so absence proves nothing.
    !incarnation.startsWith(`${attachment.runtime_epoch}:`)
  ) {
    // After reboot, process-table absence proves the PTY and handle are gone.
    const liveness = await runtime
      .inspectTerminalProcessIncarnationLiveness(
        incarnation,
        db.getWorkerTerminalResourceByOwner(dispatchId)?.host_scope ?? null
      )
      .catch(() => 'unverifiable' as const)
    return liveness === 'exited' ? { terminal: null, exact: true, status: 'exited' } : observation
  }
  if (observation.status !== 'live') {
    return observation
  }
  // PTY shells outlive killed agents; accept only hook-proven exits after this dispatch attached.
  const agent = await (
    runtime.checkTerminalAgentPresence?.(
      attachment.terminal_handle,
      // Why not rounded up: attach forgets earlier exits, so one in the creation second is the worker's.
      orchestrationTimestampToMs(attachment.created_at)
    ) ?? Promise.resolve(null)
  ).catch(() => 'unverifiable' as const)
  return agent === 'exited' ? { ...observation, status: 'exited', agentWait: null } : observation
}
