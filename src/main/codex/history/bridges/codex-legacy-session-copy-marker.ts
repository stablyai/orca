import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

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

// Optional fields fall back to absent, so a marker an older build wrote stays readable.
const markerSchema = lazyZodSchema(() =>
  z.object({
    sourcePath: z.string(),
    sourceSize: z.number(),
    sourceMtimeMs: z.number(),
    targetSize: z.number(),
    targetMtimeMs: z.number(),
    kept: z.literal(true).optional().catch(undefined),
    verified: z.string().optional().catch(undefined),
    aside: z.string().optional().catch(undefined)
  })
)

export function parseLegacyCopiedSessionMarker(text: string): LegacyCopiedSessionMarker | null {
  let fields: unknown
  try {
    fields = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = markerSchema.safeParse(fields)
  if (!parsed.success) {
    return null
  }
  const { kept, verified, aside, ...marker } = parsed.data
  return {
    ...marker,
    ...(kept ? { kept } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(aside !== undefined ? { aside } : {})
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

/**
 * Older builds swap a copy whose size and mtime still match its marker, finding the source by the
 * marker's exact path; respelling that path makes them skip it. Only those copies are respelled:
 * older builds' usage scan keys a changed copy's skipped bytes on the exact spelling.
 */
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
    await protectMarker(markerPath, marker, join(managedHome, 'sessions', relativePath))
  }
}

export async function protectMarker(
  markerPath: string,
  marker: LegacyCopiedSessionMarker,
  copyPath: string
): Promise<LegacyCopiedSessionMarker> {
  // Kept markers already name a file older builds skip, so they never need the copy checked again.
  if (marker.kept || marker.sourcePath.includes(`${sep}.${sep}`)) {
    return marker
  }
  const copy = await lstat(copyPath).catch(() => null)
  return copy?.isFile() && copy.size === marker.targetSize && copy.mtimeMs === marker.targetMtimeMs
    ? writeMarker(markerPath, {
        ...marker,
        sourcePath: protectedSpelling(normalize(marker.sourcePath))
      })
    : marker
}
