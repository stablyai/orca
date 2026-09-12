/** Host-dialect assertions and process-liveness fragments shared by the POSIX lifecycle path. */
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export function assertPosixOrcadHost(host: RemoteHostPlatform): void {
  if (isWindowsRemoteHost(host)) {
    throw new Error('Expected the POSIX orcad lifecycle command path')
  }
}

/** PID of the launched orcad, written into its own version dir at launch. */
export const ORCAD_PID_FILENAME = '.orcad-pid'

/**
 * A shell function answering whether a PID is a *running* process.
 *
 * `kill -0` alone is not that question. It succeeds for a zombie — a process that has
 * exited but whose parent has not reaped it — so a stop loop built on it reports
 * `STILL_RUNNING` for a process that is already gone, and GC reports a dead version dir as
 * in use. Verified against a real zombie on macOS; the `ps` state check is what separates
 * the two.
 *
 * A host without `ps` yields an empty state, which falls through to "alive" — the safe
 * direction for both callers.
 */
export function posixProcessAliveShellFunction(): string {
  return (
    'orcad_alive() { kill -0 "$1" 2>/dev/null || return 1; ' +
    'case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*) return 1;; esac; return 0; };'
  )
}
