import type { BigIntStats } from 'node:fs'
import { link, lstat, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, join, normalize, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import {
  legacySessionCopyMarkerPath,
  parseLegacyCopiedSessionMarker,
  protectedSpelling,
  writeMarker
} from './codex-legacy-session-copy-marker'

/** The legacy copy's own bytes stay under this name once its source is linked in. */
export const LEGACY_SESSION_COPY_ASIDE_SUFFIX = '.orca-legacy-copy'
const COMPARE_CHUNK_BYTES = 1024 * 1024
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** `kept`: the copy holds bytes its source lacks, or its source can't be linked beside it, for good. */
export type LegacySessionCopySwap = 'swapped' | 'kept' | 'deferred' | 'none'

/** `exhausted`: a copy found too little left, so the pass starts no more swaps. */
export type LegacySessionCopyReadBudget = { bytes: number; exhausted?: boolean }

const swapsInFlight = new Map<string, Promise<LegacySessionCopySwap>>()

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
  const running = swapsInFlight.get(copyPath)
  if (running) {
    return running
  }
  const task = swap(args, copyPath)
    .catch((error: unknown) => {
      console.warn('[codex-session-bridge] Legacy session copy left in place:', copyPath, error)
      return 'deferred' as const
    })
    .finally(() => swapsInFlight.delete(copyPath))
  swapsInFlight.set(copyPath, task)
  return task
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
  const asidePath = `${copyPath}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}`
  let copy = await lstatIfPresent(copyPath)
  if (!copy) {
    // A pass stopped after moving the copy aside: its name comes back before anything else.
    if (!(await lstatIfPresent(asidePath))?.isFile()) {
      return 'none'
    }
    // Under the deletion guard: a cleanup deleting this chat must not see its name come back.
    if (
      (await linkCodexRolloutUnlessHeld(sourcePath, () => linkUnlessTaken(asidePath, copyPath))) ===
      'held'
    ) {
      return 'deferred'
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
  if (!marker.sourcePath.includes(`${sep}.${sep}`)) {
    marker = await writeMarker(markerPath, { ...marker, sourcePath: protectedSpelling(sourcePath) })
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
  // A spare name a stopped pass left for the copy.
  await removeExtraName(asidePath, copyPath)
  // Written since it was copied: a pane resumed it here, so it is its own history for good.
  const copyTimes = await lstat(copyPath)
  if (copyTimes.size !== marker.targetSize || copyTimes.mtimeMs !== marker.targetMtimeMs) {
    await writeMarker(markerPath, { ...marker, kept: true })
    return 'kept'
  }
  // Before the reads and names below: a home without lock files never proves a copy idle.
  if (!(await keepsThreadLocks(args.managedHome))) {
    return 'deferred'
  }
  // Without file identities nothing can prove the name still holds the copy that was checked.
  if (copy.ino === 0n || source.ino === 0n) {
    await writeMarker(markerPath, { ...marker, kept: true })
    return 'kept'
  }
  if ((await lstatIfPresent(asidePath)) || !(await isCopyIdle(args))) {
    return 'deferred'
  }
  const proof = `${copy.dev}:${copy.ino}:${copy.size}:${copy.mtimeNs}|${source.dev}:${source.ino}`
  if (marker.verified !== proof || source.size < copy.size) {
    if (args.readBudget) {
      if (copy.size > BigInt(args.readBudget.bytes)) {
        args.readBudget.exhausted = true
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
  const settled = marker
  const outcome = await linkCodexRolloutUnlessHeld(sourcePath, () =>
    publishSourceOverCopy({ copyPath, asidePath, sourcePath, copy, source, args })
  )
  if (outcome === 'swapped') {
    await unlinkIfPresent(markerPath)
  } else if (outcome === 'kept') {
    await writeMarker(markerPath, { ...settled, kept: true })
  }
  return outcome === 'held' ? 'deferred' : outcome
}

async function publishSourceOverCopy({
  copyPath,
  asidePath,
  sourcePath,
  copy,
  source,
  args
}: {
  copyPath: string
  asidePath: string
  sourcePath: string
  copy: BigIntStats
  source: BigIntStats
  args: { managedHome: string; relativePath: string }
}): Promise<LegacySessionCopySwap> {
  const current = await lstatIfPresent(copyPath)
  if (
    !current ||
    !isUnchangedCopy(current, copy) ||
    (await lstatIfPresent(asidePath)) ||
    !(await isCopyIdle(args))
  ) {
    return 'deferred'
  }
  // A rename never leaves the copy's bytes unnamed; on Windows it fails while a writer holds the file.
  await rename(copyPath, asidePath)
  const moved = await lstatIfPresent(asidePath)
  if (!moved || !isUnchangedCopy(moved, copy)) {
    // Replaced or written in the moment before the rename: the name goes back to what was moved.
    await restoreName(asidePath, copyPath)
    return 'deferred'
  }
  // The prefix check covered this source file; one put in its place since gets checked next pass.
  const currentSource = await lstatIfPresent(sourcePath)
  if (!currentSource || !sameFile(currentSource, source)) {
    await restoreName(asidePath, copyPath)
    return 'deferred'
  }
  try {
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

/**
 * A Codex writing the copy runs with the copy's home as CODEX_HOME and holds the thread's lock
 * there; a home with no lock folder has had no Codex that keeps them, so nothing proves it idle.
 */
async function isCopyIdle(args: { managedHome: string; relativePath: string }): Promise<boolean> {
  if (!(await keepsThreadLocks(args.managedHome))) {
    return false
  }
  const locks = join(args.managedHome, 'thread-writer-locks')
  // A reverted thread's name carries its thread id and its rollout id: either can be the lock's.
  const ids = basename(args.relativePath).toLowerCase().match(UUID_PATTERN) ?? []
  if (ids.length === 0) {
    return false
  }
  for (const id of ids) {
    try {
      await lstat(join(locks, `${id}.lock`))
      return false
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return false
      }
    }
  }
  return true
}

async function keepsThreadLocks(home: string): Promise<boolean> {
  // A shared-history home links this folder into the store, so follow the link.
  return (await stat(join(home, 'thread-writer-locks')).catch(() => null))?.isDirectory() === true
}

function isUnchangedCopy(current: BigIntStats, copy: BigIntStats): boolean {
  return sameFile(current, copy) && current.size === copy.size && current.mtimeNs === copy.mtimeNs
}

async function sourceStartsWithCopy(
  copyPath: string,
  sourcePath: string,
  copy: BigIntStats
): Promise<boolean> {
  const copyFile = await open(copyPath, 'r')
  try {
    const sourceFile = await open(sourcePath, 'r')
    try {
      const [opened, source] = await Promise.all([
        copyFile.stat({ bigint: true }),
        sourceFile.stat({ bigint: true })
      ])
      if (!sameFile(opened, copy)) {
        throw new Error('The legacy copy changed while it was opened.')
      }
      const size = Number(copy.size)
      if (source.size < copy.size) {
        return false
      }
      const copyChunk = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK_BYTES, size))
      const sourceChunk = Buffer.allocUnsafe(copyChunk.length)
      for (let offset = 0; offset < size; offset += copyChunk.length) {
        const length = Math.min(copyChunk.length, size - offset)
        const [fromCopy, fromSource] = await Promise.all([
          copyFile.read(copyChunk, 0, length, offset),
          sourceFile.read(sourceChunk, 0, length, offset)
        ])
        if (
          fromCopy.bytesRead !== length ||
          fromSource.bytesRead !== length ||
          !copyChunk.subarray(0, length).equals(sourceChunk.subarray(0, length))
        ) {
          return false
        }
      }
      return true
    } finally {
      await sourceFile.close()
    }
  } finally {
    await copyFile.close()
  }
}

/** Gives the file at `asidePath` its name back unless something else took it; the aside goes only then. */
async function restoreName(asidePath: string, path: string): Promise<void> {
  await linkUnlessTaken(asidePath, path)
  await removeExtraName(asidePath, path)
}

async function linkUnlessTaken(existingPath: string, path: string): Promise<void> {
  try {
    await link(existingPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
      throw error
    }
  }
}

/** Removes `path` only while it is a second name of the file at `otherName`. */
async function removeExtraName(path: string, otherName: string): Promise<void> {
  const [extra, other] = await Promise.all([lstatIfPresent(path), lstatIfPresent(otherName)])
  if (extra?.isFile() && other?.isFile() && sameFile(extra, other)) {
    await unlinkIfPresent(path)
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n
}

async function lstatIfPresent(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
}
