import {
  type RuntimeTerminalUnavailableReason,
  terminalUnavailableMessage,
  TERMINAL_PTY_DEGRADATION_CAPABILITY,
  TERMINAL_UNAVAILABLE_ERROR_CODE,
  type RuntimeDegradation
} from '../../shared/runtime-types'

/** Entry-point PTY probes run before node-pty imports and runtime construction, so retain failures at module scope.
 * Silence means no failure proved, never proof of working PTYs; unprobed hosts report no degradation. */
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
