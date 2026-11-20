import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, sep } from 'node:path'

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
  /** The aside name the latest attempt reserved, in the copy's folder. */
  aside?: string
}

export function legacySessionCopyMarkerPath(managedHome: string, relativePath: string): string {
  return join(managedHome, '.orca-session-copies', `${relativePath}.json`)
}

export function parseLegacyCopiedSessionMarker(text: string): LegacyCopiedSessionMarker | null {
  let fields: unknown
  try {
    fields = JSON.parse(text)
  } catch {
    return null
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return null
  }
  const field = (key: keyof LegacyCopiedSessionMarker): unknown => Reflect.get(fields, key)
  const [sourcePath, sourceSize, sourceMtimeMs, targetSize, targetMtimeMs, kept, verified, aside] =
    [
      field('sourcePath'),
      field('sourceSize'),
      field('sourceMtimeMs'),
      field('targetSize'),
      field('targetMtimeMs'),
      field('kept'),
      field('verified'),
      field('aside')
    ]
  if (
    typeof sourcePath !== 'string' ||
    typeof sourceSize !== 'number' ||
    typeof sourceMtimeMs !== 'number' ||
    typeof targetSize !== 'number' ||
    typeof targetMtimeMs !== 'number'
  ) {
    return null
  }
  return {
    sourcePath,
    sourceSize,
    sourceMtimeMs,
    targetSize,
    targetMtimeMs,
    ...(kept === true ? { kept } : {}),
    ...(typeof verified === 'string' ? { verified } : {}),
    ...(typeof aside === 'string' ? { aside } : {})
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

/** Older builds match a marker's source by exact path; the respelled one makes them skip it. */
export async function protectLegacySessionCopyMarker(
  managedHome: string,
  relativePath: string
): Promise<void> {
  const markerPath = legacySessionCopyMarkerPath(managedHome, relativePath)
  const marker = await readFile(markerPath, 'utf-8').then(
    parseLegacyCopiedSessionMarker,
    () => null
  )
  if (marker) {
    await protectMarker(markerPath, marker)
  }
}

export async function protectMarker(
  markerPath: string,
  marker: LegacyCopiedSessionMarker
): Promise<LegacyCopiedSessionMarker> {
  return marker.sourcePath.includes(`${sep}.${sep}`)
    ? marker
    : writeMarker(markerPath, {
        ...marker,
        sourcePath: protectedSpelling(normalize(marker.sourcePath))
      })
}
