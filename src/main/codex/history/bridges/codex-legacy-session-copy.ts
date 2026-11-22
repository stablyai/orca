import type { BigIntStats } from 'node:fs'
import { link, lstat, open, readFile, rename } from 'node:fs/promises'
import { basename, dirname, join, normalize } from 'node:path'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import {
  legacySessionCopyMarkerPath,
  parseLegacyCopiedSessionMarker,
  protectLegacySessionCopyMarker,
  protectMarker,
  writeMarker,
  type LegacyCopiedSessionMarker
} from './codex-legacy-session-copy-marker'
import { sourceStartsWithCopy } from './codex-legacy-session-copy-prefix'
import { restoreMovedCopy } from './codex-legacy-session-copy-recovery'
import { runAloneForCopy } from './codex-legacy-session-copy-turns'
import {
  LEGACY_SESSION_COPY_ASIDE_SUFFIX,
  LEGACY_SESSION_COPY_MAX_ASIDES
} from './codex-legacy-session-copy-asides'
import {
  distinctFolders,
  isCopyIdle,
  keepsThreadLocks,
  threadIdsOf
} from './codex-legacy-session-copy-writer-locks'
import { legacyCopyLocks } from './codex-legacy-session-copy-lock-holder'
import {
  linkUnlessTaken,
  lstatIfPresent,
  sameFile,
  unlinkIfPresent
} from './codex-legacy-session-copy-name-ops'

export { settleLegacySessionCopyName } from './codex-legacy-session-copy-recovery'
export {
  LEGACY_SESSION_COPY_ASIDE_SUFFIX,
  LEGACY_SESSION_COPY_MAX_ASIDES
} from './codex-legacy-session-copy-asides'

/** What one publish costs a background pass's read budget, bounding publishes per pass. */
const PUBLISH_BUDGET_BYTES = 64 * 1024

/** `kept`: the copy holds bytes its source lacks, or its source can't be linked beside it, for good. */
export type LegacySessionCopySwap = 'swapped' | 'kept' | 'deferred' | 'none'

/**
 * `exhausted`: a copy found too little left, so the pass starts no more swaps. A copy larger than
 * a whole pass's `limit` is left to resume-time swaps and never ends the pass.
 */
export type LegacySessionCopyReadBudget = { bytes: number; limit: number; exhausted?: boolean }

/**
 * Points a legacy copy's name at its source, which Codex kept writing, without losing a byte: the
 * source must start with every byte of the copy, no Codex may hold the thread in the copy's home,
 * the copy is moved to an aside name and kept there, and the source is linked in only where no
 * other file has taken the name.
 */
export function swapLegacySessionCopy(args: {
  managedHome: string
  relativePath: string
  /** Bridge passes skip a marker recorded for another source. */
  expectedSourcePath?: string
  /** Copy bytes a background pass may still compare; resume-time swaps have no limit. */
  readBudget?: LegacySessionCopyReadBudget
}): Promise<LegacySessionCopySwap> {
  const copyPath = join(args.managedHome, 'sessions', args.relativePath)
  return runAloneForCopy(copyPath, args.readBudget ? 'limited' : 'full', () => swap(args, copyPath))
}

/**
 * Hides a legacy copy's marker from older builds, never while a swap of the copy runs: a marker
 * written from an earlier read would drop the aside the swap just recorded.
 */
export function protectLegacySessionCopy(args: {
  managedHome: string
  relativePath: string
}): Promise<LegacySessionCopySwap> {
  const copyPath = join(args.managedHome, 'sessions', args.relativePath)
  return runAloneForCopy(copyPath, 'limited', async (): Promise<LegacySessionCopySwap> => {
    await protectLegacySessionCopyMarker(args.managedHome, args.relativePath)
    return 'none'
  })
}

async function swap(
  args: Parameters<typeof swapLegacySessionCopy>[0],
  copyPath: string
): Promise<LegacySessionCopySwap> {
  const markerPath = legacySessionCopyMarkerPath(args.managedHome, args.relativePath)
  let marker = await readFile(markerPath, 'utf-8').then(parseLegacyCopiedSessionMarker, () => null)
  if (!marker || marker.kept) {
    return 'none'
  }
  const sourcePath = normalize(marker.sourcePath)
  if (args.expectedSourcePath && sourcePath !== normalize(args.expectedSourcePath)) {
    return 'none'
  }
  // First, so no exit below leaves the marker to an older build's destructive swap.
  marker = await protectMarker(markerPath, marker, copyPath)
  let copy = await lstatIfPresent(copyPath)
  if (!copy) {
    const restored = await restoreMovedCopy(marker, sourcePath, copyPath)
    if (restored !== 'restored') {
      return restored === 'held' ? 'deferred' : 'none'
    }
    copy = await lstatIfPresent(copyPath)
    if (!copy) {
      return 'deferred'
    }
  }
  if (copy.isSymbolicLink()) {
    await unlinkIfPresent(markerPath)
    return 'none'
  }
  const source = await lstatIfPresent(sourcePath)
  if (!copy.isFile() || !source?.isFile()) {
    return 'deferred'
  }
  if (sameFile(copy, source)) {
    // An earlier pass linked the source in and stopped before clearing the marker.
    await unlinkIfPresent(markerPath)
    return 'swapped'
  }
  // Written since it was copied: a pane resumed it here, so it is its own history for good.
  const copyTimes = await lstat(copyPath)
  if (copyTimes.size !== marker.targetSize || copyTimes.mtimeMs !== marker.targetMtimeMs) {
    // Older builds skip a changed copy anyway, and their usage scan needs the exact spelling.
    await writeMarker(markerPath, { ...marker, sourcePath, kept: true })
    return 'kept'
  }
  // Before the reads and names below: a home without lock files never proves a copy idle.
  if (!(await keepsThreadLocks(args.managedHome))) {
    return 'deferred'
  }
  // Without file identities nothing can prove the name still holds the copy that was checked, and
  // across volumes the source can never be linked in.
  if (copy.ino === 0n || source.ino === 0n || copy.dev !== source.dev) {
    await writeMarker(markerPath, { ...marker, kept: true })
    return 'kept'
  }
  // Codex writes or rewrites a rollout only under its thread's lock, taken with its home's
  // coordination held: under a hold, no Codex can start on this thread in either home.
  const sourceSessions = dirname(dirname(dirname(dirname(sourcePath))))
  if (
    basename(sourceSessions) !== 'sessions' ||
    !(await keepsThreadLocks(dirname(sourceSessions)))
  ) {
    return 'deferred'
  }
  // A home whose lock folder links to the other's would take that folder's coordination twice.
  const locksDirs = await distinctFolders([
    join(dirname(sourceSessions), 'thread-writer-locks'),
    join(args.managedHome, 'thread-writer-locks')
  ])
  const threadIds = threadIdsOf(args.relativePath)
  // Before any bytes are read, and after the hold's sweep drops locks a crashed Codex left.
  if (
    (await legacyCopyLocks.whileUnlocked(locksDirs, threadIds, () => isCopyIdle(args))) !== true
  ) {
    return 'deferred'
  }
  // The source's change time: an in-place rewrite of the same file voids the check too.
  const proof = `${copy.dev}:${copy.ino}:${copy.size}:${copy.mtimeNs}|${source.dev}:${source.ino}:${source.ctimeNs}`
  if (marker.verified !== proof || source.size < copy.size) {
    if (args.readBudget) {
      if (copy.size > BigInt(args.readBudget.bytes)) {
        args.readBudget.exhausted ||= copy.size <= BigInt(args.readBudget.limit)
        return 'deferred'
      }
      args.readBudget.bytes -= Number(copy.size)
    }
    if (!(await sourceStartsWithCopy(copyPath, sourcePath, copy))) {
      await writeMarker(markerPath, { ...marker, kept: true })
      return 'kept'
    }
    marker = await writeMarker(markerPath, { ...marker, verified: proof })
  }
  if (args.readBudget) {
    if (args.readBudget.bytes < PUBLISH_BUDGET_BYTES) {
      args.readBudget.exhausted = true
      return 'deferred'
    }
    args.readBudget.bytes -= PUBLISH_BUDGET_BYTES
  }
  const settled = marker
  const locked = await linkCodexRolloutUnlessHeld(sourcePath, () =>
    legacyCopyLocks.whileUnlocked(locksDirs, threadIds, () =>
      publishSourceOverCopy({
        copyPath,
        markerPath,
        marker: settled,
        sourcePath,
        copy,
        source,
        args
      })
    )
  )
  const outcome = locked === 'busy' ? 'deferred' : locked
  if (outcome === 'swapped') {
    await unlinkIfPresent(markerPath)
  } else if (outcome === 'kept') {
    await writeMarker(markerPath, { ...settled, kept: true })
  }
  return outcome === 'held' ? 'deferred' : outcome
}

async function publishSourceOverCopy({
  copyPath,
  markerPath,
  marker,
  sourcePath,
  copy,
  source,
  args
}: {
  copyPath: string
  markerPath: string
  marker: LegacyCopiedSessionMarker
  sourcePath: string
  copy: BigIntStats
  source: BigIntStats
  args: { managedHome: string; relativePath: string }
}): Promise<LegacySessionCopySwap> {
  const current = await lstatIfPresent(copyPath)
  if (!current || !isUnchangedCopy(current, copy) || !(await isCopyIdle(args))) {
    return 'deferred'
  }
  const asidePath = await reserveAside(copyPath, markerPath, marker)
  if (!asidePath) {
    return 'kept'
  }
  if (!(await supportsHardLinks(asidePath))) {
    return 'kept'
  }
  // A rename never leaves the copy's bytes unnamed; on Windows it fails while a writer holds it.
  await rename(copyPath, asidePath)
  // From here on, any outcome but a published source gives the copy its name back.
  try {
    const moved = await lstatIfPresent(asidePath)
    // Replaced or written in the moment before the rename: the name goes back to what was moved.
    if (!moved || !isUnchangedCopy(moved, copy)) {
      await restoreName(asidePath, copyPath)
      return 'deferred'
    }
    // The prefix check covered this source as it was; one replaced or written since (an in-place
    // rewrite keeps the file) gets checked again next pass.
    const currentSource = await lstatIfPresent(sourcePath)
    if (
      !currentSource ||
      !sameFile(currentSource, source) ||
      currentSource.ctimeNs !== source.ctimeNs ||
      currentSource.size !== source.size
    ) {
      await restoreName(asidePath, copyPath)
      return 'deferred'
    }
    // Unlike a rename, a link never replaces a file another process put at the name meanwhile.
    await link(sourcePath, copyPath)
    return 'swapped'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EEXIST') {
      return 'deferred'
    }
    await restoreName(asidePath, copyPath)
    if (code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      return 'kept'
    }
    throw error
  }
}

function isUnchangedCopy(current: BigIntStats, copy: BigIntStats): boolean {
  return sameFile(current, copy) && current.size === copy.size && current.mtimeNs === copy.mtimeNs
}

/** Gives the file at `asidePath` its name back unless something else took it; the aside name stays. */
async function restoreName(asidePath: string, path: string): Promise<void> {
  await linkUnlessTaken(asidePath, path)
}

/**
 * An empty file of ours the copy moves onto, recorded before the move so a pass that stops after it
 * finds the copy. An earlier attempt's unused one is reused, so nothing of ours is ever removed.
 */
async function reserveAside(
  copyPath: string,
  markerPath: string,
  marker: LegacyCopiedSessionMarker
): Promise<string | null> {
  if (marker.aside) {
    const earlier = join(dirname(copyPath), marker.aside)
    const reservation = await lstatIfPresent(earlier)
    if (reservation?.isFile() && reservation.size === 0n) {
      return earlier
    }
  }
  // Numbered in order and never removed here, so cleanup finds them all by counting up from 1.
  for (let attempt = 1; attempt <= LEGACY_SESSION_COPY_MAX_ASIDES; attempt += 1) {
    const asideName = `${basename(copyPath)}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}.${attempt}`
    const asidePath = join(dirname(copyPath), asideName)
    try {
      await (await open(asidePath, 'wx')).close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
        continue
      }
      throw error
    }
    await writeMarker(markerPath, { ...marker, aside: asideName })
    return asidePath
  }
  return null
}

/** Probed on our own empty reservation, before anything of the user's moves; the probe name stays. */
async function supportsHardLinks(reservedPath: string): Promise<boolean> {
  try {
    // One probe name per copy, beside its asides, however many attempts it takes.
    await link(reservedPath, `${reservedPath.replace(/\.\d+$/, '')}.probe`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      return false
    }
    // Anything else, EPERM included, may pass: the swap waits for a later pass.
    if (code !== 'EEXIST') {
      throw error
    }
  }
  return true
}
