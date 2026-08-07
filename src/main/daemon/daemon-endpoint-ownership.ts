/* Ownership of the daemon's canonical endpoint name and of the scratch entries the
   rename-claim protocol leaves behind. Kept apart from daemon-spawner so the rule that
   decides who may serve on the socket path is readable on its own. */
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The exact directory entry a daemon owns. Compared before any endpoint removal. */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint }

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * Why: `sockaddr_un.sun_path` caps a Unix socket path at ~104 bytes, so this must not extend
 * the canonical path — it replaces the basename with a shorter one, which keeps the bind name
 * strictly shorter than the endpoint the caller already requires to fit.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.b${randomBytes(5).toString('hex')}`)
}

/**
 * Publishes a bound listener under the canonical endpoint name.
 *
 * Why: Node/libuv unlinks the pathname a server bound to when that server closes,
 * with no ownership check — a daemon exiting late therefore deletes whichever socket
 * currently sits at that path, including a live replacement's. Binding a unique path
 * and hard-linking it into place instead means libuv only ever unlinks the private
 * bind name, and the exclusive link doubles as the kernel-enforced endpoint claim.
 */
export function publishDaemonSocketPath(
  boundPath: string,
  canonicalPath: string
): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    // Named pipes are not directory entries; the pipe name itself is exclusive.
    return null
  }
  // Why: stat the bound name first — the link shares the inode, so a racing unlink of the
  // canonical name cannot erase our identity and leave the endpoint unwatched and uncleanable.
  const identity = readDaemonSocketIdentity(boundPath)
  try {
    linkSync(boundPath, canonicalPath)
  } catch (error) {
    if (isFileExistsError(error)) {
      throw error
    }
    // Why: a filesystem without hard links must not stop the daemon from starting. Rename
    // still moves the bind name out from under libuv, which preserves the property that
    // matters most — a late close cannot delete a replacement's endpoint. Exclusivity
    // degrades to check-then-act here, which is no weaker than binding the path directly.
    if (existsSync(canonicalPath)) {
      throw error
    }
    renameSync(boundPath, canonicalPath)
    return identity
  }
  try {
    unlinkSync(boundPath)
  } catch {
    // Inert: clients resolve the canonical link, and the bind name is unique to us.
  }
  return identity
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

export function readDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stats = statSync(socketPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

export function daemonSocketIdentityMatches(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null
): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino
}

/** 'indeterminate' is deliberately distinct from 'lost': only positive evidence may retire a daemon. */
export type DaemonEndpointOwnershipState = 'owned' | 'lost' | 'indeterminate'

export function readDaemonEndpointOwnershipState(
  socketPath: string,
  owned: DaemonSocketIdentity | null
): DaemonEndpointOwnershipState {
  if (process.platform === 'win32' || !owned) {
    return 'indeterminate'
  }
  try {
    const stats = statSync(socketPath, { bigint: true })
    return stats.dev === owned.dev && stats.ino === owned.ino ? 'owned' : 'lost'
  } catch (error) {
    // Why: a stat that failed for any reason other than "the entry is gone" proves nothing.
    // Treating EACCES or EIO as lost ownership would retire a perfectly healthy daemon.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Removes the canonical endpoint name only while it still resolves to our own listener. */
export function unlinkOwnedDaemonSocketPath(
  socketPath: string,
  owned: DaemonSocketIdentity | null
): boolean {
  if (process.platform === 'win32' || !owned) {
    return false
  }
  if (!daemonSocketIdentityMatches(readDaemonSocketIdentity(socketPath), owned)) {
    return false
  }
  try {
    unlinkSync(socketPath)
    return true
  } catch {
    return false
  }
}

const ABANDONED_DAEMON_CLAIM_PATTERN =
  /(?:\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\.b[0-9a-f]{10})$/

const ABANDONED_DAEMON_CLAIM_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Reclaims claim/bind scratch names left behind when a rename-claim or bind publish
 * could not remove its own temporary entry. Age-gated so a claim in flight is never touched.
 */
export function sweepAbandonedDaemonClaims(
  runtimeDir: string,
  minAgeMs = ABANDONED_DAEMON_CLAIM_MIN_AGE_MS,
  now = Date.now()
): number {
  let swept = 0
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!ABANDONED_DAEMON_CLAIM_PATTERN.test(entry)) {
      continue
    }
    const claimPath = join(runtimeDir, entry)
    try {
      if (now - statSync(claimPath).mtimeMs < minAgeMs) {
        continue
      }
      unlinkSync(claimPath)
      swept++
    } catch {
      // Best-effort; a locked or already-removed claim is retried on a future launch.
    }
  }
  return swept
}
