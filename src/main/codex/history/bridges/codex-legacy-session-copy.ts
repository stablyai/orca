import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import { getOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { linkCodexSessionFile } from '../rollouts/codex-session-link'
import { isCodexThreadOpen } from '../rollouts/codex-thread-open-check'

export type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

/**
 * Replaces a copy Orca made earlier with a link to its source, only when the source still holds
 * every byte of the copy and no Codex has the thread open. The copy moves aside rather than being
 * deleted until the swap is rechecked, so a write that lands meanwhile puts it back.
 */
export async function migrateLegacyCopiedSessionBridge(
  sourceHomePath: string,
  sourcePath: string,
  targetPath: string,
  relativePath: string
): Promise<void> {
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return
  }
  const threadHomes = [getOrcaManagedCodexHomePath(), sourceHomePath]
  const safeToReplace = async (copyPath: string, checked: Stats): Promise<boolean> =>
    sameStats(lstatSync(copyPath), checked) &&
    sourceStartsWithCopy(sourcePath, copyPath) &&
    !(await isCodexThreadOpen(threadHomes, targetPath))
  let replacementPath: string | null = null
  let heldPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink()) {
      clearLegacyCopiedSessionMarker(relativePath)
      return
    }
    if (
      !fileStatsMatchMarker(targetStat, marker, 'target') ||
      !(await safeToReplace(targetPath, targetStat))
    ) {
      return
    }
    const suffix = `${process.pid}-${Date.now()}`
    replacementPath = `${targetPath}.orca-link-${suffix}`
    if (!linkCodexSessionFile(sourcePath, replacementPath)) {
      replacementPath = null
      return
    }
    heldPath = `${targetPath}.orca-held-${suffix}`
    renameSync(targetPath, heldPath)
    renameSync(replacementPath, targetPath)
    replacementPath = null
    // Rechecked after the swap: anything written to the copy since the check survives.
    if (!(await safeToReplace(heldPath, targetStat))) {
      renameSync(heldPath, targetPath)
      heldPath = null
      return
    }
    rmSync(heldPath, { force: true })
    heldPath = null
    clearLegacyCopiedSessionMarker(relativePath)
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to migrate copied system Codex session:',
      sourcePath,
      error
    )
    if (heldPath) {
      try {
        renameSync(heldPath, targetPath)
      } catch (restoreError) {
        console.warn('[codex-session-bridge] Copy kept at', heldPath, restoreError)
      }
    }
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
}

function sameStats(current: Stats, checked: Stats): boolean {
  return (
    current.isFile() &&
    current.ino === checked.ino &&
    current.size === checked.size &&
    current.mtimeMs === checked.mtimeMs
  )
}

/** Whether `sourcePath` begins with every byte of the copy, so linking to it loses nothing. */
function sourceStartsWithCopy(sourcePath: string, copyPath: string): boolean {
  const copy = readFileSync(copyPath)
  const source = Buffer.alloc(copy.length)
  const fd = openSync(sourcePath, 'r')
  try {
    let read = 0
    while (read < copy.length) {
      const bytes = readSync(fd, source, read, copy.length - read, read)
      if (bytes === 0) {
        return false
      }
      read += bytes
    }
  } finally {
    closeSync(fd)
  }
  return source.equals(copy)
}

function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

export function readLegacyCopiedSessionMarker(
  relativePath: string
): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as Record<string, unknown>
    if (
      typeof marker.sourcePath !== 'string' ||
      typeof marker.sourceSize !== 'number' ||
      typeof marker.sourceMtimeMs !== 'number' ||
      typeof marker.targetSize !== 'number' ||
      typeof marker.targetMtimeMs !== 'number'
    ) {
      return null
    }
    return marker as LegacyCopiedSessionMarker
  } catch {
    return null
  }
}

export function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}

export function clearLegacyCopiedSessionMarker(relativePath: string): void {
  rmSync(getLegacySessionCopyMarkerPath(relativePath), { force: true })
}
