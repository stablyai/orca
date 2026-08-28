import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Correction — the fence has to survive Orca not answering, and has to be
 *  provably the fence for THIS workspace.
 *
 *  The hook gate denies by replying to a loopback POST. If the runtime is gone,
 *  crashed or mid-restart, that POST fails and the managed script has nothing to
 *  ask — which is fine for an ordinary session and exactly wrong for a worktree
 *  with a gate running on it.
 *
 *  So a lease also drops a file. Three properties make it trustworthy rather
 *  than merely present:
 *    - its NAME is a lossy transform of the worktree id, so two workspaces can
 *      collide on it; the file therefore carries the exact worktree id and the
 *      reader compares it, so a collision cannot fence the wrong tree;
 *    - it carries an absolute expiry, so a marker orphaned by a crash stops
 *      denying on its own rather than wedging the workspace forever;
 *    - it is written atomically and its creation is VERIFIED, so a lease can
 *      refuse to report itself acquired when its fallback fence does not exist.
 */

export class FenceSentinelUnavailable extends Error {
  readonly code = 'fence_sentinel_unavailable'
}

/** Sits beside the endpoint file the managed scripts already source, so a hook
 *  that can find its endpoint can find this without new environment. */
export function fenceDirFor(endpointFilePath: string): string {
  return join(dirname(endpointFilePath), 'fence')
}

/** The lookup prefix a filename starts with.
 *
 *  Deliberately NOT a hash: the shell side has to compute the identical prefix
 *  with no runtime, and `shasum`/`sha256sum` are not both present everywhere. A
 *  transform that disagreed between the two sides would silently MISS the
 *  sentinel and allow the mutation.
 *
 *  It is LOSSY — two deep checkouts differing near the root collapse to the same
 *  prefix — so it is only a way to narrow the directory scan. It is never the
 *  identity: one file per LEASE keeps colliding workspaces from overwriting each
 *  other, and the exact worktree id inside each file decides which one applies. */
export function fenceKeyFor(worktreeId: string): string {
  return worktreeId.slice(-64).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The collision-resistant half of the filename, derived by the RUNTIME from the
 *  exact worktree id.
 *
 *  The shell never computes this — it globs `<prefix>.*.fence` and compares the
 *  exact id inside each candidate — so it is free to be a hash the reader has no
 *  way to reproduce. That is the point: the earlier scheme keyed the second half
 *  on the caller's lease id, and two colliding workspaces that chose the same
 *  lease id (or ids that sanitized alike) still overwrote one marker, leaving
 *  the first workspace silently unfenced. Uniqueness must not depend on a
 *  caller's choices. */
export function fenceIdentityFor(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 32)
}

/** One file per WORKSPACE. A scope holds at most one lease, so a workspace needs
 *  at most one marker, and two workspaces can never share a filename. */
export function fenceFileFor(endpointFilePath: string, worktreeId: string): string {
  return join(
    fenceDirFor(endpointFilePath),
    `${fenceKeyFor(worktreeId)}.${fenceIdentityFor(worktreeId)}.fence`
  )
}

/** Line 1: the exact worktree id. Line 2: absolute expiry, epoch seconds.
 *  Line 3: the lease id, for diagnosis. Plain lines because the reader is
 *  `/bin/sh` and a JSON parser there would be a second thing to get wrong.
 *
 *  Expiry rounds UP. Flooring would retire the offline fence up to 999ms before
 *  the database lease it mirrors, leaving a sub-second window where the row says
 *  protected and the only fence a disconnected worker can see says otherwise. */
export function serializeFenceSentinel(args: {
  worktreeId: string
  leaseId: string
  acquiredAt: string
  expiresAtMs: number
}): string {
  return `${args.worktreeId}\n${Math.ceil(args.expiresAtMs / 1000)}\n${args.leaseId}\n${args.acquiredAt}\n`
}

/** Writes the sentinel and proves it landed. Throws when it did not: the caller
 *  must not report a lease acquired whose offline fence does not exist. */
export function writeFenceSentinel(args: {
  endpointFilePath: string
  worktreeId: string
  leaseId: string
  acquiredAt: string
  expiresAtMs: number
}): string {
  const path = fenceFileFor(args.endpointFilePath, args.worktreeId)
  const contents = serializeFenceSentinel(args)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // Atomic: a reader must never see a half-written marker and conclude the
    // workspace is unfenced because line 1 was truncated.
    const staging = `${path}.${process.pid}.tmp`
    writeFileSync(staging, contents, { mode: 0o600 })
    renameSync(staging, path)
  } catch (error) {
    throw new FenceSentinelUnavailable(
      `Could not write the offline validation fence at ${path}: ${String(error)}`
    )
  }
  // Read back rather than trust the write: this file is the only fence left when
  // Orca is unreachable, and "probably written" is not a fence.
  if (readFileSync(path, 'utf8') !== contents) {
    throw new FenceSentinelUnavailable(
      `The offline validation fence at ${path} did not read back as written.`
    )
  }
  return path
}

/** Called when the lease is released. Verified too: a marker left behind keeps
 *  denying until it expires, so a failed clear must be visible. */
export function clearFenceSentinel(
  endpointFilePath: string,
  worktreeId: string,
  expected: { leaseId: string; acquiredAt: string }
): boolean {
  const path = fenceFileFor(endpointFilePath, worktreeId)
  try {
    let current: string
    try {
      current = readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return false
      }
      throw error
    }
    const [, , leaseId, acquiredAt] = current.split('\n')
    // Compare the runtime-generated acquisition generation, not just the
    // caller-visible lease id. Release A can finish after acquisition B has
    // replaced the one-per-worktree marker; A must never unlink B's fence.
    if (leaseId !== expected.leaseId || acquiredAt !== expected.acquiredAt) {
      return false
    }
    rmSync(path, { force: true })
  } catch (error) {
    throw new FenceSentinelUnavailable(
      `Could not clear the offline validation fence at ${path}: ${String(error)}`
    )
  }
  return true
}

/** The reader's contract, mirrored in the managed script. Exported so a test can
 *  pin the two against each other rather than hoping they agree. */
export function fenceSentinelDenies(
  contents: string | null,
  worktreeId: string,
  nowMs: number
): boolean {
  if (!contents) {
    return false
  }
  const [markedWorktree, expiry] = contents.split('\n')
  // A lossy filename prefix can collide; the exact id cannot.
  if (markedWorktree !== worktreeId) {
    return false
  }
  // Why a full-string test and not parseInt: parseInt('123abc') is 123, but the
  // shell's `case $e in *[!0-9]*)` rejects it. A parser that accepted what the
  // reader refuses would make the two halves disagree about whether a workspace
  // is fenced.
  if (!/^[0-9]+$/.test(expiry ?? '')) {
    return false
  }
  const expiresAtSeconds = Number.parseInt(expiry as string, 10)
  // Seconds, matching the shell's `date +%s` comparison exactly.
  return expiresAtSeconds > Math.floor(nowMs / 1000)
}

/** True when ANY of a workspace's markers still fences it. Mirrors the shell's
 *  scan: several files can share the lossy prefix, and only the record whose
 *  exact worktree id matches — and has not expired — decides. */
export function anyFenceSentinelDenies(
  records: readonly (string | null)[],
  worktreeId: string,
  nowMs: number
): boolean {
  return records.some((contents) => fenceSentinelDenies(contents, worktreeId, nowMs))
}
