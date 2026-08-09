// Reads real notch geometry from the bundled Swift helper.
// Everything here degrades to "no notch" rather than throwing: a missing or misbehaving helper
// must leave the indicator on its pill presentation, never break the window.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const HELPER_EXECUTABLE = 'orca-screen-geometry'
const HELPER_TIMEOUT_MS = 3000

export type ScreenNotchGeometry = {
  displayId: number
  /** Height of the camera housing band; the collapsed bar's height on a notched display. */
  safeAreaTop: number
  /** Offsets from the screen's own left edge, so callers add Electron's display.bounds.x. */
  notchLeadingOffsetX: number | null
  notchTrailingOffsetX: number | null
}

let cachedHelperPath: string | null | undefined

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', HELPER_EXECUTABLE)]
    : [
        join(
          app.getAppPath(),
          'native',
          'screen-geometry-macos',
          '.build',
          'release',
          HELPER_EXECUTABLE
        ),
        join(
          process.cwd(),
          'native',
          'screen-geometry-macos',
          '.build',
          'release',
          HELPER_EXECUTABLE
        )
      ]
  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  return cachedHelperPath
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Why: helper stdout is parsed as untrusted input — a partial or malformed row must be dropped
// rather than produce NaN geometry that silently mispositions the window.
function parseGeometry(stdout: string): Map<number, ScreenNotchGeometry> {
  const byDisplayId = new Map<number, ScreenNotchGeometry>()
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return byDisplayId
  }
  const rows = (parsed as { displays?: unknown })?.displays
  if (!Array.isArray(rows)) {
    return byDisplayId
  }
  for (const row of rows) {
    const entry = row as Partial<ScreenNotchGeometry>
    if (!isFiniteNumber(entry.displayId) || !isFiniteNumber(entry.safeAreaTop)) {
      continue
    }
    const leading = isFiniteNumber(entry.notchLeadingOffsetX) ? entry.notchLeadingOffsetX : null
    const trailing = isFiniteNumber(entry.notchTrailingOffsetX) ? entry.notchTrailingOffsetX : null
    byDisplayId.set(entry.displayId, {
      displayId: entry.displayId,
      safeAreaTop: entry.safeAreaTop,
      // A cutout needs both edges and positive width; anything else is the pill case.
      notchLeadingOffsetX:
        leading !== null && trailing !== null && trailing > leading ? leading : null,
      notchTrailingOffsetX:
        leading !== null && trailing !== null && trailing > leading ? trailing : null
    })
  }
  return byDisplayId
}

function runHelper(helperPath: string): Promise<Map<number, ScreenNotchGeometry>> {
  return new Promise((resolve) => {
    execFile(helperPath, [], { timeout: HELPER_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? new Map() : parseGeometry(String(stdout)))
    })
  })
}

let readInFlight: Promise<Map<number, ScreenNotchGeometry>> | null = null

/**
 * Notch geometry per Electron display id. Empty map when the helper is unavailable, which the
 * caller reads as "every display is a pill".
 *
 * Callers should invalidate on `screen` display events rather than polling — the helper spawns
 * a process, so it must never sit on a per-frame path.
 */
export function readScreenGeometry(): Promise<Map<number, ScreenNotchGeometry>> {
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return Promise.resolve(new Map())
  }
  // Startup and a display-change burst can both ask at once; one run answers all of them.
  if (readInFlight) {
    return readInFlight
  }
  readInFlight = runHelper(helperPath).finally(() => {
    readInFlight = null
  })
  return readInFlight
}

/** Test seam: the helper path is resolved once and cached for the process lifetime. */
export function resetScreenGeometryCacheForTests(): void {
  cachedHelperPath = undefined
  readInFlight = null
}

export { parseGeometry as parseScreenGeometryForTests }
