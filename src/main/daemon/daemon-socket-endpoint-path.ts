/** Relocate overlong Unix socket paths; token, PID record and history stay under userData (#17840). */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { posix } from 'node:path'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { hasErrorCode } from './daemon-process-inspection'
import { PRIVATE_DIR_MODE } from './daemon-private-file-modes'

// Keep the fallback path independent of user-directory length.
export const SHORT_DAEMON_SOCKET_DIR_PREFIX = '/tmp/.orca-daemon-'

export function shortDaemonSocketDir(runtimeDir: string, uid: number): string {
  const runtimeHash = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
  return `${SHORT_DAEMON_SOCKET_DIR_PREFIX}${uid}/${runtimeHash}`
}

export function resolveDaemonUnixSocketPath(
  runtimeDir: string,
  socketName: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()
): string {
  const preferred = posix.join(runtimeDir, socketName)
  if (
    uid === undefined ||
    unixSocketPathFits(preferred, platform === 'darwin' ? 'darwin' : 'linux')
  ) {
    return preferred
  }
  return posix.join(shortDaemonSocketDir(runtimeDir, uid), socketName)
}

/** Refuse untrusted directories without repairing their permissions. */
export function ensureOwnedPrivateDir(dir: string, uid: number): void {
  try {
    mkdirSync(dir, { mode: PRIVATE_DIR_MODE })
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error
    }
  }
  const entry = lstatSync(dir)
  if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o077) !== 0) {
    throw new Error(`Daemon socket directory ${dir} is not a private directory owned by this user`)
  }
}

/** Check before connecting too: a planted listener at this predictable path could receive the hello token. */
export function ensureDaemonSocketDir(
  socketPath: string,
  uid: number | undefined = process.getuid?.()
): void {
  if (uid === undefined || !socketPath.startsWith(`${SHORT_DAEMON_SOCKET_DIR_PREFIX}${uid}/`)) {
    return
  }
  const runtimeDir = posix.dirname(socketPath)
  ensureOwnedPrivateDir(posix.dirname(runtimeDir), uid)
  ensureOwnedPrivateDir(runtimeDir, uid)
}

export function daemonSocketDirIsTrusted(socketPath: string): boolean {
  try {
    ensureDaemonSocketDir(socketPath)
    return true
  } catch {
    return false
  }
}
