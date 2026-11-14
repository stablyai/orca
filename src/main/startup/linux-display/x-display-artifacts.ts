import { readFileSync, rmSync, statSync } from 'node:fs'

export function xvfbSocketPath(displayNumber: number): string {
  return `/tmp/.X11-unix/X${displayNumber}`
}

export function xDisplayLockPath(displayNumber: number): string {
  return `/tmp/.X${displayNumber}-lock`
}

// Sockets outlive X servers; lock PID proves liveness. Callers distinguish missing external locks from torn managed teardown.
export type DisplayLockProbe = 'alive' | 'dead' | 'missing'

export function probeDisplayLock(displayNumber: number): DisplayLockProbe {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim(), 10)
  } catch (error) {
    // Unreadable locks cannot be cleared; distinguish them from absence.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'dead'
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'dead'
  }
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    // EPERM proves another UID owns a live PID.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
      ? 'alive'
      : 'dead'
  }
}

/** Missing foreign locks may reflect container socket mounts/WSLg/PID namespaces; unlike crashes (which retain locks), these endpoints must remain usable. */
export function isForeignDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) !== 'dead'
}

/** Require a live managed lock: our cleanup unlinks lock first, so lockless sockets can be torn teardown and must not be adopted. */
export function isManagedDisplayServerAlive(displayNumber: number): boolean {
  return probeDisplayLock(displayNumber) === 'alive'
}

export type DisplayOwnership = 'free' | 'mine' | 'foreign'

/** Never adopt/remove another account's display or sticky-/tmp leftovers; its owner can stop it independently. */
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
      // Best effort; failed cleanup surfaces during subsequent Xvfb startup.
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

// Abstract X sockets have no filesystem entry but kernel ownership proves liveness and removes them on exit.
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
