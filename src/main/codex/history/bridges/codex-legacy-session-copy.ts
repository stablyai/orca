import type { BigIntStats } from 'node:fs'
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import { isCodexRolloutOpenInCodex } from '../rollouts/codex-rollout-open-check'

/** The legacy copy's own bytes stay under this name once its source is linked in. */
export const LEGACY_SESSION_COPY_ASIDE_SUFFIX = '.orca-legacy-copy'
/** A refused copy's marker, renamed so older builds (which swap on size and mtime alone) skip it. */
export const LEGACY_SESSION_COPY_KEPT_SUFFIX = '.kept'
const LEGACY_SESSION_LINK_SUFFIX = '.orca-legacy-link'
const COMPARE_CHUNK_BYTES = 1024 * 1024

export type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

/** `kept`: the copy holds bytes its source lacks and stays a separate file for good. */
export type LegacySessionCopySwap = 'swapped' | 'kept' | 'deferred' | 'none'

export function legacySessionCopyMarkerPath(managedHome: string, relativePath: string): string {
  return join(managedHome, '.orca-session-copies', `${relativePath}.json`)
}

export function parseLegacyCopiedSessionMarker(text: string): LegacyCopiedSessionMarker | null {
  try {
    const marker: unknown = JSON.parse(text)
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      return null
    }
    const fields = marker as Record<string, unknown>
    return typeof fields.sourcePath === 'string' &&
      typeof fields.sourceSize === 'number' &&
      typeof fields.sourceMtimeMs === 'number' &&
      typeof fields.targetSize === 'number' &&
      typeof fields.targetMtimeMs === 'number'
      ? (fields as LegacyCopiedSessionMarker)
      : null
  } catch {
    return null
  }
}

const swapsInFlight = new Map<string, Promise<LegacySessionCopySwap>>()

/**
 * Points a legacy copy's name at its source, which Codex kept writing, without losing a byte: the
 * source must start with every byte of the copy, no Codex may have the thread open, the copy keeps
 * an aside name, and the source is published only over the copy that was checked.
 */
export function swapLegacySessionCopy(args: {
  managedHome: string
  relativePath: string
  /** Bridge passes skip a marker recorded for another source. */
  expectedSourcePath?: string
  /** Bytes a background pass may still read; resume-time swaps read without a limit. */
  readBudget?: { bytes: number }
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
  const marker = await readFile(markerPath, 'utf-8').then(
    parseLegacyCopiedSessionMarker,
    () => null
  )
  if (!marker || (args.expectedSourcePath && marker.sourcePath !== args.expectedSourcePath)) {
    return 'none'
  }
  const copy = await lstatIfPresent(copyPath)
  if (!copy) {
    return 'none'
  }
  if (copy.isSymbolicLink()) {
    await unlinkIfPresent(markerPath)
    return 'none'
  }
  const source = await lstatIfPresent(marker.sourcePath)
  if (!copy.isFile() || !source?.isFile()) {
    return 'deferred'
  }
  const linkPath = `${copyPath}${LEGACY_SESSION_LINK_SUFFIX}`
  if (sameFile(copy, source)) {
    // An earlier pass published the source and stopped before clearing the marker.
    await removeExtraName(linkPath, marker.sourcePath)
    await unlinkIfPresent(markerPath)
    return 'swapped'
  }
  // Written since it was copied: a pane resumed it here, so it is its own history now.
  const copyTimes = await lstat(copyPath)
  if (copyTimes.size !== marker.targetSize || copyTimes.mtimeMs !== marker.targetMtimeMs) {
    return 'deferred'
  }
  const homes = locksHomes(args, marker.sourcePath)
  if (await isCodexRolloutOpenInCodex(homes, args.relativePath)) {
    return 'deferred'
  }
  if (args.readBudget) {
    if (copy.size > BigInt(args.readBudget.bytes)) {
      return 'deferred'
    }
    args.readBudget.bytes -= Number(copy.size)
  }
  const outcome = await linkCodexRolloutUnlessHeld(marker.sourcePath, () =>
    replaceCopyWithSource({
      copyPath,
      sourcePath: marker.sourcePath,
      copy,
      source,
      homes,
      relativePath: args.relativePath
    })
  )
  if (outcome === 'swapped') {
    await unlinkIfPresent(markerPath)
  } else if (outcome === 'kept') {
    await rename(markerPath, `${markerPath}${LEGACY_SESSION_COPY_KEPT_SUFFIX}`)
  }
  return outcome === 'held' ? 'deferred' : outcome
}

async function replaceCopyWithSource({
  copyPath,
  sourcePath,
  copy,
  source,
  homes,
  relativePath
}: {
  copyPath: string
  sourcePath: string
  copy: BigIntStats
  source: BigIntStats
  homes: string[]
  relativePath: string
}): Promise<LegacySessionCopySwap> {
  const asidePath = `${copyPath}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}`
  const linkPath = `${copyPath}${LEGACY_SESSION_LINK_SUFFIX}`
  try {
    // Linked before the read: a copy its source can't be linked beside (another volume) is never read.
    if (!(await linkAs(sourcePath, linkPath, source))) {
      return 'deferred'
    }
    if (!(await sourceStartsWithCopy(copyPath, sourcePath, copy))) {
      return 'kept'
    }
    // The copy keeps a name of its own: a writer that opened it before the rename loses nothing.
    if (!(await linkAs(copyPath, asidePath, copy))) {
      return 'kept'
    }
    const current = await lstatIfPresent(copyPath)
    if (
      !current ||
      !sameFile(current, copy) ||
      current.size !== copy.size ||
      current.mtimeNs !== copy.mtimeNs ||
      (await isCodexRolloutOpenInCodex(homes, relativePath))
    ) {
      return 'deferred'
    }
    await rename(linkPath, copyPath)
    return 'swapped'
  } finally {
    // Spare names only: the source's temporary link, and the aside while the copy still has its name.
    await removeExtraName(linkPath, sourcePath)
    await removeExtraName(asidePath, copyPath)
  }
}

/** True once `path` names `expected`: linked now, or by an earlier pass that stopped. */
async function linkAs(existingPath: string, path: string, expected: BigIntStats): Promise<boolean> {
  try {
    await link(existingPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
      throw error
    }
  }
  const linked = await lstatIfPresent(path)
  return linked !== null && sameFile(linked, expected)
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

/** Removes `path` only while it is a second name of the file at `otherName`. */
async function removeExtraName(path: string, otherName: string): Promise<void> {
  const [extra, other] = await Promise.all([lstatIfPresent(path), lstatIfPresent(otherName)])
  if (extra?.isFile() && other?.isFile() && sameFile(extra, other)) {
    await unlinkIfPresent(path)
  }
}

/** The copy's home and the source's, where a Codex with this thread open holds its lock. */
function locksHomes(args: { managedHome: string; relativePath: string }, sourcePath: string) {
  const suffix = join('sessions', args.relativePath)
  return sourcePath.endsWith(suffix)
    ? [args.managedHome, sourcePath.slice(0, -suffix.length)]
    : [args.managedHome]
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
