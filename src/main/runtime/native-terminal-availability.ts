import {
  type RuntimeTerminalUnavailableReason,
  terminalUnavailableMessage,
  TERMINAL_PTY_DEGRADATION_CAPABILITY,
  TERMINAL_UNAVAILABLE_ERROR_CODE,
  type RuntimeDegradation
} from '../../shared/runtime-types'

/**
 * A note left by whoever proved this host cannot load or spawn PTYs, read back when
 * `status.get` assembles `degradations[]`.
 *
 * Why a module-level note rather than a constructor argument: only the host entry point
 * can run the out-of-process load probe, and it must run before anything requires
 * `node-pty` — long before `OrcaRuntimeService` exists. This is the same shape
 * `runtime-browser-commands-factory` uses for `browser_unavailable`, for the same reason.
 *
 * Silence means "nothing proved it broken", never "proved working". Hosts that never
 * run a precondition therefore report no degradation, which is the honest answer.
 */
export type RuntimeTerminalUnavailableCause = {
  reason: RuntimeTerminalUnavailableReason
  detail?: string
}

let unavailableCause: RuntimeTerminalUnavailableCause | null = null

export function setRuntimeTerminalUnavailableCause(
  cause: RuntimeTerminalUnavailableCause | null
): void {
  unavailableCause = cause
}

export function runtimeTerminalUnavailableCause(): RuntimeTerminalUnavailableCause | null {
  return unavailableCause
}

/** The degradation entry for the recorded cause, or null when nothing is degraded. */
export function runtimeTerminalDegradation(): RuntimeDegradation | null {
  const cause = unavailableCause
  if (!cause) {
    return null
  }
  return {
    code: TERMINAL_UNAVAILABLE_ERROR_CODE,
    capability: TERMINAL_PTY_DEGRADATION_CAPABILITY,
    message: terminalUnavailableMessage(cause.reason, cause.detail),
    reason: cause.reason,
    ...(cause.detail ? { detail: cause.detail } : {})
  }
}
