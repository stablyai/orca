/** Expected Windows update-relaunch wedge drain time (#8697); recovery must allow this to finish. */
export const TRANSIENT_WEDGE_DRAIN_MS = 20_000

/** Give health-check timeouts a longer second opinion without spending the whole recovery budget. */
export const DAEMON_RECOVERY_PROBE_MS = 8_000

/**
 * Leave 25.5s of the 60s startup gate for kill (10.5s), readiness (10s), and adoption/connects (5s).
 * This 32s budget permits transient recovery but replaces later-draining wedges the old ~60s grace could adopt.
 * Failed-replacement endpoint rescue retains its own timeout, allowing recovery after the startup gate opens.
 */
export const DAEMON_RECOVERY_BUDGET_MS = 32_000

/** Clamp each probe to the recovery deadline, with a 1ms floor. */
export function daemonRecoveryProbeTimeoutMs(recoveryDeadlineMs: number): number {
  return Math.max(1, Math.min(DAEMON_RECOVERY_PROBE_MS, recoveryDeadlineMs - Date.now()))
}
