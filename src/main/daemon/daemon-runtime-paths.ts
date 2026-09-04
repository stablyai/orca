/**
 * Every path the daemon's endpoint is built from, and whether a data root leaves room for it.
 *
 * One leaf module, importing only node builtins and the protocol version, for two reasons: the
 * names are a single source of truth shared by the spawner, the ownership protocol and orcad,
 * and the doctor needs the arithmetic below without dragging the daemon into the CLI's graph.
 */
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import {
  measureUnixSocketPathBudget,
  UNIX_SOCKET_PATH_LIMIT,
  type UnixSocketPathBudget
} from '../../shared/unix-socket-path-budget'

/**
 * The daemon's runtime directory, as a path only. Separate from `getDaemonRuntimeDir`, which
 * also creates it: the socket-path budget has to measure a root before anything touches it.
 */
export function getDaemonRuntimeDirPath(userDataPath: string): string {
  return join(userDataPath, 'daemon')
}

export function getDaemonSocketPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  // Why: Windows IPC servers use named pipes rather than filesystem socket
  // files. Include the protocol version in the endpoint name so a daemon from
  // an older build is never reused after a breaking protocol change.
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\orca-terminal-host-v${protocolVersion}-${suffix}`
  }
  return join(runtimeDir, `daemon-v${protocolVersion}.sock`)
}

export function getDaemonTokenPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.token`)
}

export function getDaemonPidPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.pid`)
}

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * `.p`, not the `.b` this used to be: released builds sweep that pattern on age alone. Replaces
 * the basename rather than extending the path, so the `sockaddr_un.sun_path` budget holds.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString('hex')}`)
}

/**
 * Whether a data root leaves room for the daemon's socket to exist.
 *
 * Why a startup question and not a runtime one: the endpoint lives under the data root, so a
 * long enough root pushes it past `sockaddr_un.sun_path` and the daemon dies before it serves
 * anything. orcad's own listener spends a few bytes less, so there is a band of root lengths
 * where orcad comes up, reports ready, and serves clients with terminal survival silently
 * switched off — every terminal then dies on the next restart, which is the one thing forking
 * a detached daemon exists to prevent.
 *
 * Pure arithmetic: no probe, no privileges, no filesystem. That is what lets the same check
 * answer for a host the doctor is only reading a unit file about.
 */
export function checkDaemonSocketPathBudget(userDataPath: string): UnixSocketPathBudget {
  const socketPath = getDaemonSocketPath(getDaemonRuntimeDirPath(userDataPath))
  if (process.platform === 'win32') {
    // Named pipes are not filesystem paths and carry no sun_path budget.
    return { longestPath: socketPath, bytes: 0, limit: UNIX_SOCKET_PATH_LIMIT, fits: true }
  }
  // Both names matter: the daemon binds the private one to listen, and every client connects to
  // the canonical one. The bind name is random but fixed-width, so measuring one is measuring
  // all of them — and measuring both means a change to either name cannot go unnoticed here.
  return measureUnixSocketPathBudget([socketPath, getDaemonSocketBindPath(socketPath)])
}

/** One wording, so the startup refusal and the doctor finding cannot drift apart. */
export function describeDaemonSocketPathOverflow(budget: UnixSocketPathBudget): string {
  return (
    `The terminal daemon's socket path needs ${budget.bytes} bytes and the kernel accepts ` +
    `${budget.limit} (${budget.longestPath}). The daemon cannot start, so terminals would ` +
    'not survive a restart.'
  )
}

/**
 * Names only mechanisms that exist. It previously offered `--user-data <path>`, which orcad
 * does not accept and — because the service commands ignored unrecognised flags — did not
 * reject either: an operator following this advice got exit 0 and an `[OK] socket path fits`
 * measured against the shell's own root, and would reasonably conclude it was fixed.
 */
export const DAEMON_SOCKET_PATH_REMEDY =
  'Move the data root to a shorter path: set ORCA_USER_DATA, and regenerate the service ' +
  'definition with it set if one is installed.'
