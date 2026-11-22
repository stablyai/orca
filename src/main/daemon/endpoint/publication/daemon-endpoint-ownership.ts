// Only publishers replace canonical entries they prove dead; see AGENTS.md for ownership rules.
import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { endpointIsProvenDead, type SocketProbeOutcome } from './daemon-endpoint-probe'

// Retried only when another publisher demonstrably took the name, so a small bound suffices.
const PUBLISH_ATTEMPTS = 3

/** Birth time is unreliable; identify directory entries by dev+ino. */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint }

/** Use a short private basename: released builds sweep .b names, and Unix socket paths are bounded. */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString('hex')}`)
}

/** Only occupied proves an owner to adopt; lost and inconclusive require declining startup. */
export class DaemonEndpointUnavailableError extends Error {
  constructor(readonly reason: 'occupied' | 'lost' | 'inconclusive') {
    super(`Daemon endpoint unavailable: ${reason}`)
    this.name = 'DaemonEndpointUnavailableError'
  }
}

/** Exit code 20 avoids Node's reserved codes and the race between IPC delivery and launcher exit. */
export const DAEMON_EXIT_ENDPOINT_OCCUPIED = 20

/** Shared so the client's retry allowlist cannot drift from the server's refusal wording. */
export const DAEMON_ENDPOINT_LOST_MESSAGE = 'Daemon no longer owns its endpoint; reconnect'

export type DaemonEndpointPublishOutcome =
  | { status: 'published'; identity: DaemonSocketIdentity | null }
  /** Adopt the live owner; never fork beside it. */
  | { status: 'occupied' }
  /** Publication lost a race; this daemon must not serve. */
  | { status: 'lost' }
  /** Leave an unclassified incumbent alone. */
  | { status: 'inconclusive' }

/** Bind privately so libuv closes only our name; link claims exclusivity before any replacement. */
export async function publishDaemonEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<DaemonEndpointPublishOutcome> {
  if (process.platform === 'win32') {
    // Named pipes are exclusive by name and vanish with the process; listen is the whole protocol.
    return { status: 'published', identity: null }
  }
  // Read the private bound inode so a racing canonical-name replacement cannot corrupt our identity.
  const identity = readDaemonSocketIdentity(boundPath)
  if (!identity) {
    throw new Error(`Cannot identify the bound daemon endpoint at ${boundPath}`)
  }
  // Retry when a name change invalidates the evidence.
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      linkSync(boundPath, canonicalPath)
    } catch (error) {
      const noHardLinks = isLinkUnsupportedError(error)
      if (!isFileExistsError(error) && !noHardLinks) {
        throw error
      }
      // Filesystems without hard links still require death proof, continuity checks and publish verification.
      const blocked = await replaceProvenDeadEndpoint(
        boundPath,
        canonicalPath,
        probeEndpoint,
        noHardLinks
      )
      if (blocked === 'evidence-stale') {
        continue
      }
      return blocked ?? confirmPublishedEndpoint(canonicalPath, identity)
    }
    try {
      unlinkSync(boundPath)
    } catch {
      // The canonical link serves clients; failure to remove our private name is harmless.
    }
    return confirmPublishedEndpoint(canonicalPath, identity)
  }
  // Repeated name changes prove no live owner to adopt.
  return { status: 'inconclusive' }
}

/** A probe that threw classified nothing, which is never proof of death. */
async function probeEndpointSafely(
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<SocketProbeOutcome> {
  try {
    return await probeEndpoint(canonicalPath)
  } catch {
    return 'unknown'
  }
}

/** Rename a proven-dead entry atomically; unlink-then-link exposes a misleading absence. */
async function replaceProvenDeadEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>,
  absentIsStable: boolean
): Promise<DaemonEndpointPublishOutcome | null | 'evidence-stale'> {
  // Capture before probing so a stalled probe cannot authorize replacing a different entry.
  const proven = readDaemonEndpointEntryIdentity(canonicalPath)
  const outcome = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (outcome === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(outcome)) {
    // An inconclusive probe must never authorize replacing a possibly live endpoint.
    return { status: 'inconclusive' }
  }
  if (
    !isSameEndpointEntry(proven, readDaemonEndpointEntryIdentity(canonicalPath), absentIsStable)
  ) {
    // A name change invalidates the death proof.
    return 'evidence-stale'
  }
  // Re-probe: a replacement can reuse the dead entry's inode and pass the continuity check.
  const stillDead = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (stillDead === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(stillDead)) {
    // Inconclusive evidence proves no owner to adopt.
    return { status: 'inconclusive' }
  }
  renameSync(boundPath, canonicalPath)
  // The caller must still verify ownership after the rename.
  return null
}

function isSameInode(a: DaemonSocketIdentity, b: DaemonSocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Inode continuity is provisional for dead entries; re-probing catches recycled inode numbers. */
function isSameEndpointEntry(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null,
  absentIsStable: boolean
): boolean {
  if (!a || !b) {
    // Two unreadable stats prove nothing; allow absent/absent only for the no-hard-link fallback.
    return absentIsStable && !a && !b
  }
  return isSameInode(a, b)
}

/** A losing publisher must stand down; our open listener prevents inode reuse during verification. */
function confirmPublishedEndpoint(
  canonicalPath: string,
  identity: DaemonSocketIdentity
): DaemonEndpointPublishOutcome {
  let published: DaemonSocketIdentity | null = null
  try {
    const stats = statSync(canonicalPath, { bigint: true })
    published = { dev: stats.dev, ino: stats.ino }
  } catch (error) {
    return isMissingFileError(error) ? { status: 'lost' } : { status: 'inconclusive' }
  }
  return isSameInode(published, identity)
    ? { status: 'published', identity: published }
    : { status: 'lost' }
}

/** lstat preserves dangling symlink identity so it can be compared before replacement. */
function readDaemonEndpointEntryIdentity(socketPath: string): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stats = lstatSync(socketPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

/** Some FUSE filesystems support sockets and rename but reject hard links. */
function isLinkUnsupportedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP' || code === 'ENOSYS'
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

/** Only positive loss evidence may retire a daemon. */
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
    // Our open listener prevents inode reuse; a false loss would retire a healthy daemon.
    return isSameInode({ dev: stats.dev, ino: stats.ino }, owned) ? 'owned' : 'lost'
  } catch (error) {
    // Permission errors do not prove ownership loss.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
