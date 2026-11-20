import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

export type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
  /** Settled as a separate file for good. */
  kept?: true
  /** Copy and source identities a completed prefix check covered, so a retry needn't reread. */
  verified?: string
}

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

/** Older builds match a marker's source by exact path, so the `/./` spelling makes them skip it. */
export function protectedSpelling(sourcePath: string): string {
  return `${dirname(sourcePath)}${sep}.${sep}${basename(sourcePath)}`
}

export async function writeMarker(
  markerPath: string,
  marker: LegacyCopiedSessionMarker
): Promise<LegacyCopiedSessionMarker> {
  const stagedPath = `${markerPath}.${process.pid}.tmp`
  try {
    await writeFile(stagedPath, JSON.stringify(marker))
    await rename(stagedPath, markerPath)
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined)
    throw error
  }
  return marker
}
