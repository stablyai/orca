import { link, lstat, readFile, unlink } from 'node:fs/promises'
import { isRolloutBytePrefix } from '../rollouts/codex-rollout-byte-prefix'

/** What an old Orca build recorded when it copied a session instead of linking it. */
export type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

let legacyCopiesSetAside = 0

/** Old session copies set aside this run, each kept beside the link that replaced it. */
export function getLegacyCopiesSetAsideCount(): number {
  return legacyCopiesSetAside
}

/**
 * An untouched old copy whose source holds every byte of it is set aside as `<name>.orca-legacy-copy`
 * (never deleted, never replacing a file) and the source linked into its name, so every reader sees
 * the turns written since. A Codex writing to the copy meanwhile keeps writing into the set-aside file.
 */
export async function setAsideLegacyCopy(
  sourcePath: string,
  targetPath: string,
  markerPath: string
): Promise<boolean> {
  const asidePath = `${targetPath}.orca-legacy-copy`
  try {
    const marker = parseLegacyCopiedSessionMarker(await readFile(markerPath, 'utf-8'))
    if (!marker || marker.sourcePath !== sourcePath) {
      return false
    }
    const [target, source] = await Promise.all([lstat(targetPath), lstat(sourcePath)])
    if (
      !target.isFile() ||
      !source.isFile() ||
      target.dev !== source.dev ||
      !fileStatsMatchMarker(target, marker, 'target') ||
      !(await isRolloutBytePrefix(targetPath, sourcePath))
    ) {
      return false
    }
    await link(targetPath, asidePath)
    await unlink(targetPath)
    try {
      await link(sourcePath, targetPath)
    } catch (error) {
      // Put the copy back, unless something took its name meanwhile: then both stay.
      await link(asidePath, targetPath)
        .then(() => unlink(asidePath))
        .catch(() => {})
      throw error
    }
    legacyCopiesSetAside += 1
    await unlink(markerPath).catch(() => {})
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      console.warn('[codex-session-bridge] Old session copy kept in place:', targetPath, error)
    }
    return false
  }
}

export function parseLegacyCopiedSessionMarker(text: string): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(text)
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
