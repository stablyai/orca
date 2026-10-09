/**
 * Keeps the daemon's Unix socket inside `sockaddr_un.sun_path`.
 *
 * The endpoint normally lives at `<userData>/daemon/daemon-v<N>.sock`. A long data root pushes
 * that past the kernel cap, and the bind then fails or "succeeds" with no directory entry, so the
 * daemon never comes up and terminals stop surviving restarts (#17840). Only then does the socket
 * move to a fixed-length per-uid base; the token, pid record and history stay under userData.
 * Windows binds named pipes, which have no such limit.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { posix } from 'node:path'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { hasErrorCode } from './daemon-process-inspection'
import { PRIVATE_DIR_MODE } from './daemon-private-file-modes'

/** `/tmp` is the only POSIX directory whose length does not depend on the user. */
const SHORT_DAEMON_SOCKET_DIR_PREFIX = '/tmp/.orca-daemon-'

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

/** Validate, never repair: a dir planted by another user or a symlink is refused, not chmod'ed. */
function ensureOwnedPrivateDir(dir: string, uid: number): void {
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

/**
 * Creates and validates the relocated socket's directories; a no-op for the default endpoint.
 * Why before every connect, not just the bind: the `/tmp` path is predictable, so a listener another
 * user planted there would otherwise receive the hello token before any bind-time check ran.
 */
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

/** Non-throwing form for probes that must fail closed instead of connecting. */
export function daemonSocketDirIsTrusted(socketPath: string): boolean {
  try {
    ensureDaemonSocketDir(socketPath)
    return true
  } catch {
    return false
  }
}
