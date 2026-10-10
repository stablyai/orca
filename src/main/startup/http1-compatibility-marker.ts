import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'

/**
 * Cached copy of `settings.electronHttp1CompatibilityMode` for pre-`ready` startup.
 * Version 2 carries the active profile ID so a profile switch cannot reuse the
 * previous profile's network compatibility choice.
 *
 * Why a standalone file (not the Store): app.commandLine.appendSwitch('disable-http2') must run
 * before the first Electron session exists, which is before the settings Store is constructed.
 * Reading it from the settings file meant a synchronous read + JSON.parse of the whole multi-MB
 * orca-data.json on the critical path of every cold start, duplicating the parse the Store does a
 * moment later. This marker is a few bytes, mirroring gpu-fallback-marker.ts.
 */

export const HTTP1_COMPATIBILITY_MARKER_FILE = 'http1-compatibility.json'
const LEGACY_MARKER_SCHEME_VERSION = 1
const MARKER_SCHEME_VERSION = 2

type Http1CompatibilityMarker = {
  schemeVersion: number
  enabled: boolean
  profileId?: string
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, HTTP1_COMPATIBILITY_MARKER_FILE)
}

/** Returns null when the marker is missing or unreadable, so callers fall back to the settings file. */
export function readHttp1CompatibilityMarker(
  userDataPath: string,
  expectedProfileId?: string
): boolean | null {
  try {
    const parsed = JSON.parse(
      readFileSync(markerPath(userDataPath), 'utf-8')
    ) as Partial<Http1CompatibilityMarker>
    if (typeof parsed.enabled !== 'boolean') {
      return null
    }
    if (parsed.schemeVersion === LEGACY_MARKER_SCHEME_VERSION) {
      // A v1 marker predates profile-scoped state. It remains useful for a
      // legacy install with no profile index, but cannot be trusted once the
      // active profile is known.
      return expectedProfileId === undefined ? parsed.enabled : null
    }
    if (
      parsed.schemeVersion !== MARKER_SCHEME_VERSION ||
      typeof parsed.profileId !== 'string' ||
      parsed.profileId.length === 0 ||
      expectedProfileId === undefined ||
      parsed.profileId !== expectedProfileId
    ) {
      return null
    }
    return parsed.enabled
  } catch {
    return null
  }
}

export function writeHttp1CompatibilityMarker(
  userDataPath: string,
  enabled: boolean,
  profileId?: string
): void {
  if (readHttp1CompatibilityMarker(userDataPath, profileId) === enabled) {
    return
  }
  const marker: Http1CompatibilityMarker =
    profileId === undefined
      ? { schemeVersion: LEGACY_MARKER_SCHEME_VERSION, enabled }
      : { schemeVersion: MARKER_SCHEME_VERSION, enabled, profileId }
  try {
    const targetPath = markerPath(userDataPath)
    writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, JSON.stringify(marker))
  } catch {
    // Best effort: a missing marker makes the next launch fail closed or read legacy JSON.
  }
}

/** Recovery must discard the old authority's cached setting before publishing JSON authority. */
export function invalidateHttp1CompatibilityMarker(userDataPath: string): void {
  rmSync(markerPath(userDataPath), { force: true })
  bestEffortFsyncDirectorySync(userDataPath)
}
