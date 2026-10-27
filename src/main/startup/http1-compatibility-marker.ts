import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'

/** A tiny profile-scoped marker selects HTTP/2 before the first Electron session without reparsing multi-MB settings before Store startup. Profile identity prevents cross-profile reuse. */

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

/** Null means absent/untrusted; callers fail closed or read legacy JSON only when profile authority allows. */
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
      // Trust v1 only for legacy installs with no known active profile.
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
