import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export type LiveCallerTerminal = {
  handle: string
  paneKey: string
  processIncarnation: string | null
}

/** A handle's terminal while it is live; an exited, unknown or foreign handle names nothing. */
export function liveTerminal(
  runtime: OrcaRuntimeService,
  handle: string
): LiveCallerTerminal | null {
  const paneKey = runtime.getLiveTerminalPaneKey(handle)
  return paneKey
    ? { handle, paneKey, processIncarnation: runtime.getTerminalProcessIncarnation(handle) }
    : null
}

/** The caller's own live terminal from its env evidence; absent, stale, foreign or scrubbed env proves nothing. */
export function evidenceCallerTerminal(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined
): LiveCallerTerminal | null {
  const envHandle = evidence?.terminalHandle
  const own = envHandle ? liveTerminal(runtime, envHandle) : null
  // A remint invalidates the env handle and the env pane key still finds the same terminal; an exited one's pane may hold another.
  const exited = envHandle
    ? runtime.getTerminalLivenessVerdict(envHandle)?.status === 'exited'
    : false
  const remintedHandle =
    !own && !exited && evidence?.paneKey
      ? runtime.getTerminalHandleForPaneKey(evidence.paneKey)
      : null
  return own ?? (remintedHandle ? liveTerminal(runtime, remintedHandle) : null)
}
