import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

export type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

/** Marker path for a legacy/copy-sync session bridge under the managed home. */
export function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

/** Reads and validates the marker for a copy-sync session bridge. */
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

/** Whether source or target file stats still match a copy-sync bridge marker. */
export function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  // Why: WSL `stat -c %Y` is second-precision (*1000); Node lstat is ms. Floor
  // both sides so copy markers still match after cp -p on Linux.
  return (
    stat.size === expectedSize &&
    Math.floor(stat.mtimeMs / 1000) === Math.floor(expectedMtimeMs / 1000)
  )
}

/** Removes the marker after a copy bridge has been migrated or retired. */
export function clearLegacyCopiedSessionMarker(relativePath: string): void {
  rmSync(getLegacySessionCopyMarkerPath(relativePath), { force: true })
}

/** Writes a marker capturing source/target size+mtime for a copy-sync bridge. */
export function writeLegacyCopiedSessionMarker(
  relativePath: string,
  sourcePath: string,
  targetPath: string
): void {
  const sourceStat = lstatSync(sourcePath)
  const targetStat = lstatSync(targetPath)
  const markerPath = getLegacySessionCopyMarkerPath(relativePath)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        sourcePath,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        targetSize: targetStat.size,
        targetMtimeMs: targetStat.mtimeMs
      } satisfies LegacyCopiedSessionMarker,
      null,
      2
    )}\n`,
    'utf-8'
  )
}
