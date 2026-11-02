import { readFileSync, rmSync, statSync } from 'node:fs'

// X server lock and socket files under /tmp, and what they say about who owns a display.

export function xvfbSocketPath(displayNumber: number): string {
  return `/tmp/.X11-unix/X${displayNumber}`
}

export function xDisplayLockPath(displayNumber: number): string {
  return `/tmp/.X${displayNumber}-lock`
}

// Why: a socket file can outlive the X server that made it. The X lock file holds the server PID;
// if that process is gone, the display is dead despite the socket. `missing` is a third outcome the
// two callers must treat differently — see each call site.
export type DisplayLockProbe = 'alive' | 'dead' | 'missing'

export function probeDisplayLock(displayNumber: number): DisplayLockProbe {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim(), 10)
  } catch (error) {
    // An unreadable lock is a lock we cannot clear: treat it as dead, not absent.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'dead'
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'dead'
  }
  try {
    // signal 0 probes existence without affecting the process.
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    // EPERM means the PID exists under another uid — a root-owned X server is still live.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
      ? 'alive'
      : 'dead'
  }
}

/**
 * Liveness for a display Orca did not create. An X server writes its lock beside the socket and
 * both survive a crash (verified against Xvfb under SIGKILL), so a socket with no lock was never
 * left by a crashed server — it is an endpoint published from elsewhere: a container bind-mounting
 * only /tmp/.X11-unix, WSLg, or a foreign PID namespace. We cannot judge those, and refusing them
 * blocks startup on displays that work.
 */
export function isForeignDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) !== 'dead'
}

/**
 * Liveness for Orca's own managed display numbers. Stricter on purpose: `removeStaleDisplayArtifacts`
 * unlinks the lock before the socket, so a lockless socket here is Orca's own half-finished
 * teardown, not a foreign endpoint. Adopting it would resurrect the orphan-socket bug and stop the
 * cleanup below from self-healing.
 */
export function isManagedDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) === 'alive'
}

export type DisplayOwnership = 'free' | 'mine' | 'foreign'

/**
 * Whose display a number is. Another account's X server, or its leftovers that this account
 * cannot unlink from sticky /tmp, must never be adopted or cleaned up: that account can stop it
 * at any moment, and its display is not ours to share.
 */
export function displayOwnership(displayNumber: number): DisplayOwnership {
  const uid = process.getuid?.()
  let present = false
  for (const path of [xDisplayLockPath(displayNumber), xvfbSocketPath(displayNumber)]) {
    let owner: number
    try {
      owner = statSync(path).uid
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue
      }
      return 'foreign'
    }
    present = true
    if (uid === undefined || owner !== uid) {
      return 'foreign'
    }
  }
  if (present) {
    return 'mine'
  }
  // A server in another mount namespace may hold only the abstract socket.
  return hasAbstractXSocket(displayNumber) ? 'foreign' : 'free'
}

export function removeStaleDisplayArtifacts(displayNumber: number): void {
  for (const path of [xDisplayLockPath(displayNumber), xvfbSocketPath(displayNumber)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort; if removal fails, Xvfb startup below will surface the error.
    }
  }
}

export function readDisplayLockPid(displayNumber: number): number | null {
  try {
    const pid = Number.parseInt(readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

// Why: an X server may bind only the abstract namespace (`@/tmp/.X11-unix/X0`), which leaves no
// filesystem socket to stat. Abstract addresses are kernel-owned and vanish the moment the owner
// exits, so an entry here is proof of a live server — no lock file needed, and no stale entry is
// possible. Refusing these was a hard startup failure with no workaround.
export function hasAbstractXSocket(displayNumber: number): boolean {
  let table: unknown
  try {
    table = readFileSync('/proc/net/unix', 'utf8')
  } catch {
    return false
  }
  if (typeof table !== 'string') {
    return false
  }
  const address = `@${xvfbSocketPath(displayNumber)}`
  return table
    .split('\n')
    .some((line) => line.slice(line.lastIndexOf(' ') + 1).trimEnd() === address)
}

export function isUnixSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}
