import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { resolveOrcaManagedCodexHomePath } from './codex-home-paths'
type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}
export type LegacyCopiedCodexSessionBridgeScanPreference = {
  sourcePath: string
  preferManagedCopy: boolean
  sourceSkipBytes: number | null
}
/** Keep resume scans coherent until legacy copies can be replaced with links. */
export function getLegacyCopiedCodexSessionBridgeScanPreference(
  sessionFilePath: string
): LegacyCopiedCodexSessionBridgeScanPreference | null {
  const managedSessionsRoot = join(resolveOrcaManagedCodexHomePath(), 'sessions')
  const relativePath = relative(managedSessionsRoot, sessionFilePath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker) {
    return null
  }

  let targetMatchesMarker = false
  let sourceMatchesMarker = false
  try {
    targetMatchesMarker = fileStatsMatchMarker(lstatSync(sessionFilePath), marker, 'target')
  } catch {}
  try {
    sourceMatchesMarker = fileStatsMatchMarker(lstatSync(marker.sourcePath), marker, 'source')
  } catch {}

  return {
    sourcePath: marker.sourcePath,
    // Legacy copies share a prefix with their source; scan one full log until they become linked.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}

function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(resolveOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed
    if (
      !('sourcePath' in marker) ||
      typeof marker.sourcePath !== 'string' ||
      !('sourceSize' in marker) ||
      typeof marker.sourceSize !== 'number' ||
      !('sourceMtimeMs' in marker) ||
      typeof marker.sourceMtimeMs !== 'number' ||
      !('targetSize' in marker) ||
      typeof marker.targetSize !== 'number' ||
      !('targetMtimeMs' in marker) ||
      typeof marker.targetMtimeMs !== 'number'
    ) {
      return null
    }
    return {
      sourcePath: marker.sourcePath,
      sourceSize: marker.sourceSize,
      sourceMtimeMs: marker.sourceMtimeMs,
      targetSize: marker.targetSize,
      targetMtimeMs: marker.targetMtimeMs
    }
  } catch {
    return null
  }
}

function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}
