/* Who may serve on the daemon's canonical endpoint name: only a daemon publishing itself onto it,
   and only by replacing an entry it has itself just proven dead. Rationale and traps: AGENTS.md. */
import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { endpointIsProvenDead, type SocketProbeOutcome } from './daemon-endpoint-probe'

// Retried only when another publisher demonstrably took the name, so a small bound suffices.
const PUBLISH_ATTEMPTS = 3

/** A daemon endpoint, identified by its directory entry. dev+ino only; birth time is unreliable. */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint }

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * `.p`, not the `.b` this used to be: released builds sweep that pattern on age alone. Replaces the
 * basename rather than extending the path, so the ~104-byte `sockaddr_un.sun_path` budget holds.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString('hex')}`)
}

/**
 * Only `occupied` establishes that someone else owns the endpoint, and only then may the caller
 * adopt rather than fork. `lost` and `inconclusive` establish no owner, so the caller must decline.
 */
export class DaemonEndpointUnavailableError extends Error {
  constructor(readonly reason: 'occupied' | 'lost' | 'inconclusive') {
    super(`Daemon endpoint unavailable: ${reason}`)
    this.name = 'DaemonEndpointUnavailableError'
  }
}

/**
 * Stand-down signal: a live daemon owns the endpoint, so the launcher should adopt it. An exit code
 * because the launcher settles its wait on process exit, which an IPC message can lose the race to.
 * 20 avoids Node's reserved 1-13, where a corrupt bundle's exit would read as a false stand-down.
 */
export const DAEMON_EXIT_ENDPOINT_OCCUPIED = 20

/** Shared so the client's retry allowlist cannot drift from the server's refusal wording. */
export const DAEMON_ENDPOINT_LOST_MESSAGE = 'Daemon no longer owns its endpoint; reconnect'

export type DaemonEndpointPublishOutcome =
  /** The endpoint name is ours. */
  | { status: 'published'; identity: DaemonSocketIdentity | null }
  /** A live daemon owns it. Adopt that daemon; never fork beside it. */
  | { status: 'occupied' }
  /** We published, and another daemon replaced us moments later. We must not serve. */
  | { status: 'lost' }
  /** The incumbent could not be classified, so it must be left alone. */
  | { status: 'inconclusive' }

/**
 * Publishes a bound listener under the canonical endpoint name.
 *
 * Bind privately, then link: libuv unlinks the pathname a server bound to when it closes, with no
 * ownership check, so binding a unique name means it can only ever unlink our own. `link` before
 * `rename` because `rename` replaces whatever it finds — `link` fails with EEXIST and forces the
 * liveness question, and on the common path it is itself the kernel-enforced exclusive claim.
 */
export async function publishDaemonEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<DaemonEndpointPublishOutcome> {
  if (process.platform === 'win32') {
    // Named pipes are exclusive by name and vanish with the process; listen is the whole protocol.
    return { status: 'published', identity: null }
  }
  // Stat the bound name, not the canonical one: the link shares the inode, so nothing racing the
  // canonical name can corrupt this reading. Failing here is cheap; startup protects nothing yet.
  const identity = readDaemonSocketIdentity(boundPath)
  if (!identity) {
    throw new Error(`Cannot identify the bound daemon endpoint at ${boundPath}`)
  }
  // Losing the name mid-protocol is not an error, it just invalidates the evidence; re-run.
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      linkSync(boundPath, canonicalPath)
    } catch (error) {
      const noHardLinks = isLinkUnsupportedError(error)
      if (!isFileExistsError(error) && !noHardLinks) {
        throw error
      }
      // Without hard links we lose `link`'s exclusivity but not the death proof, the continuity
      // re-check, or the post-publish verification — and that last one is what keeps replacing an
      // unclaimable name safe rather than a silent overwrite.
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
      // Inert: clients resolve the canonical link, and the bind name is unique to us.
    }
    return confirmPublishedEndpoint(canonicalPath, identity)
  }
  // Inconclusive, not occupied: being outrun says the name keeps changing hands, not that anything
  // is serving it — no probe ever connected.
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

/**
 * Replaces an occupied endpoint name, but only once nothing can be serving it. `rename`, not
 * unlink-then-link: the latter leaves the name absent between two calls, and every concurrent
 * observer can land in that gap and conclude something false.
 */
async function replaceProvenDeadEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>,
  absentIsStable: boolean
): Promise<DaemonEndpointPublishOutcome | null | 'evidence-stale'> {
  // Captured first: `rename` replaces whatever is at the name, so without something to compare, a
  // probe that stalled while another daemon published would license destroying that daemon.
  const proven = readDaemonEndpointEntryIdentity(canonicalPath)
  const outcome = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (outcome === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(outcome)) {
    // Collapsing "could not classify" into "dead" deletes endpoints that are still serving.
    return { status: 'inconclusive' }
  }
  if (
    !isSameEndpointEntry(proven, readDaemonEndpointEntryIdentity(canonicalPath), absentIsStable)
  ) {
    // The name changed hands while we probed, so the death proof describes an entry that is gone.
    return 'evidence-stale'
  }
  // Ask again rather than compare metadata: the entry we proved dead can be unlinked and its inode
  // number handed straight back to a replacement, which then matches on dev+ino and looks like
  // continuity. Whether anything is *serving* is the property that matters, and connecting asks it.
  const stillDead = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (stillDead === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(stillDead)) {
    // Same three-way split: 'occupied' would send the launcher to adopt a daemon that may not exist.
    return { status: 'inconclusive' }
  }
  renameSync(boundPath, canonicalPath)
  // null means "the name is ours now" — the caller still has to confirm it kept it.
  return null
}

/** Same directory entry. No birth-time term — see AGENTS.md on why that field cannot carry it. */
function isSameInode(a: DaemonSocketIdentity, b: DaemonSocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Absent-and-still-absent counts as unchanged; one side absent does not. The entry compared here is
 * believed dead, so its inode can be freed and reissued — being wrong costs one retry here, but
 * would retire a serving daemon at the ownership check, which is why only this side may use it.
 */
function isSameEndpointEntry(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null,
  absentIsStable: boolean
): boolean {
  if (!a || !b) {
    // Where an entry demonstrably existed, two unreadable stats prove nothing. Where the
    // filesystem has no hard links, absent-then-absent is stable and there is nothing to destroy.
    return absentIsStable && !a && !b
  }
  return isSameInode(a, b)
}

/**
 * Confirms the name we just took is still ours: two daemons can prove the same entry dead and both
 * replace it, and the loser must never serve. dev+ino is decisive here because our own listener
 * holds the inode open while we ask, so the number cannot be recycled underneath us.
 */
function confirmPublishedEndpoint(
  canonicalPath: string,
  identity: DaemonSocketIdentity
): DaemonEndpointPublishOutcome {
  let published: DaemonSocketIdentity | null = null
  try {
    const stats = statSync(canonicalPath, { bigint: true })
    published = { dev: stats.dev, ino: stats.ino }
  } catch (error) {
    // The name is gone or unreadable, so we have no evidence we are reachable.
    return isMissingFileError(error) ? { status: 'lost' } : { status: 'inconclusive' }
  }
  // The fresh reading: this is what the watchdog compares against, so it must describe the entry
  // as it now stands, not as it was before the link or rename that published it.
  return isSameInode(published, identity)
    ? { status: 'published', identity: published }
    : { status: 'lost' }
}

/**
 * The directory entry itself, not what it resolves to. `lstat`, because a dangling symlink occupies
 * the name but `stat` follows it, fails, and reports absent — which reads as "changed hands".
 */
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

/**
 * Whether `link` failed because the filesystem cannot do it at all, not because the name was taken.
 * Some FUSE filesystems accept a bound socket and `rename` but refuse hard links.
 */
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
    // dev+ino suffices: `owned` is our own socket and its listener is open whenever this runs, so
    // the kernel cannot recycle that number. A false loss is sticky and retires a healthy daemon.
    return isSameInode({ dev: stats.dev, ino: stats.ino }, owned) ? 'owned' : 'lost'
  } catch (error) {
    // Anything but "the entry is gone" proves nothing; EACCES would retire a healthy daemon.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
