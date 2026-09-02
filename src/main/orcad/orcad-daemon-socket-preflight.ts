/**
 * Refuses a data root whose daemon socket path cannot fit in `sockaddr_un.sun_path`.
 *
 * Why this refuses where a failed daemon start does not: `startOrcadDaemon` is deliberately
 * fail-open, because the reasons a daemon fails at runtime are unenumerable and often
 * transient, and a host that cannot fork one can still serve git and worktrees. This failure
 * is none of those things — it is known before anything is attempted, it is permanent until
 * an operator changes a value they supplied, and it is arithmetic. That puts it with the bind
 * address and the instance lock, which already refuse, rather than with the runtime failures.
 *
 * The alternative is what the field found: orcad's own listener is a few bytes shorter than
 * the daemon's, so a root in that band comes up, reports ready, and serves normally with
 * survival off. The warning it prints goes to journald, and a host with volatile journald
 * loses it on the reboot that also destroys every terminal.
 *
 * Its own module, and importing only path arithmetic, so `orcad-entry` can call it without
 * pulling the daemon (and node-pty behind it) into the static graph the native preflight
 * has to run ahead of.
 */
import {
  checkDaemonSocketPathBudget,
  DAEMON_SOCKET_PATH_REMEDY,
  describeDaemonSocketPathOverflow
} from '../daemon/daemon-runtime-paths'

export class OrcadDaemonSocketPathError extends Error {
  readonly code = 'orcad_daemon_socket_path_too_long'
}

export function assertDaemonSocketPathFits(userDataPath: string): void {
  const budget = checkDaemonSocketPathBudget(userDataPath)
  if (!budget.fits) {
    throw new OrcadDaemonSocketPathError(
      `${describeDaemonSocketPathOverflow(budget)} ${DAEMON_SOCKET_PATH_REMEDY}`
    )
  }
}
