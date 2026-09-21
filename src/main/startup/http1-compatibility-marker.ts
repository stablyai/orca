import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cached copy of `settings.electronHttp1CompatibilityMode` for pre-`ready` startup.
 *
 * Why a standalone file (not the Store): app.commandLine.appendSwitch('disable-http2') must run
 * before the first Electron session exists, which is before the settings Store is constructed.
 * Reading it from the settings file meant a synchronous read + JSON.parse of the whole multi-MB
 * orca-data.json on the critical path of every cold start, duplicating the parse the Store does a
 * moment later. This marker is a few bytes, mirroring gpu-fallback-marker.ts.
 */

export const HTTP1_COMPATIBILITY_MARKER_FILE = 'http1-compatibility.json'
const MARKER_SCHEME_VERSION = 1

type Http1CompatibilityMarker = {
  schemeVersion: number
  enabled: boolean
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, HTTP1_COMPATIBILITY_MARKER_FILE)
}

/** Returns null when the marker is missing or unreadable, so callers fall back to the settings file. */
export function readHttp1CompatibilityMarker(userDataPath: string): boolean | null {
  try {
    const parsed = JSON.parse(
      readFileSync(markerPath(userDataPath), 'utf-8')
    ) as Partial<Http1CompatibilityMarker>
    if (parsed.schemeVersion !== MARKER_SCHEME_VERSION || typeof parsed.enabled !== 'boolean') {
      return null
    }
    return parsed.enabled
  } catch {
    return null
  }
}

export function writeHttp1CompatibilityMarker(userDataPath: string, enabled: boolean): void {
  if (readHttp1CompatibilityMarker(userDataPath) === enabled) {
    return
  }
  const marker: Http1CompatibilityMarker = { schemeVersion: MARKER_SCHEME_VERSION, enabled }
  try {
    writeFileSync(markerPath(userDataPath), JSON.stringify(marker))
  } catch {
    // Best effort: a missing marker just costs the next launch the settings-file fallback.
  }
}
