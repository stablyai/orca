import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

export type LegacyCopiedCodexSessionScanPreference = {
  sourcePath: string
  preferManagedCopy: boolean
  sourceSkipBytes: number | null
}

/** Read-only compatibility for copies created by older Orca releases. */
export function getLegacyCopiedCodexSessionScanPreference(
  sessionFilePath: string
): LegacyCopiedCodexSessionScanPreference | null {
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
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
    // Why: keep legacy prefix copies readable without creating or refreshing
    // any writable alias between the two authority homes.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}

function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
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

function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}
