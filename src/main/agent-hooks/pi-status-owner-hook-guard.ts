import { PI_STATUS_OWNER_ENV_KEYS } from '../../shared/pi-status-owner-env'

// Why (#22011): a child agent under Pi (`devin acp`) inherits Pi's pane key; Pi already reports its status.

/** Must follow payload capture: POSIX hooks own stdin before any exit (#8110). */
export function buildPosixPiStatusOwnerHookGuardLines(): string[] {
  // Why kill -0: a stale PID in a long-lived descendant (e.g. a tmux server) must not silence the pane.
  // Why 0*: `kill -0 0` (or `00`) probes the whole process group and always succeeds.
  return PI_STATUS_OWNER_ENV_KEYS.map(
    (key) =>
      `case "\${${key}:-}" in ''|0*|*[!0-9]*) ;; *) kill -0 "$${key}" 2>/dev/null && exit 0 ;; esac`
  )
}

/** Form lines naming the owner; the listener drops the event while that PID lives (hasLivePiStatusOwner). */
export function buildWindowsPiStatusOwnerFormLines(): string[] {
  // Why not skip in cmd: it has no builtin liveness probe, and tasklist per event costs time and EDR signal.
  return PI_STATUS_OWNER_ENV_KEYS.map((key) => `  --data-urlencode "${key}=%${key}%" ^`)
}
