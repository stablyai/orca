import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Why: written by the watchdog worker when main-thread heartbeats stop, and rewritten if
// they resume; consumed on the next launch to report how long the stall lasted and whether it ever
// cleared. `selfRecovered` separates a real deadlock from a long-but-survivable stall — the two are
// indistinguishable at detection time, and only the latter would have been a destructive kill.
export type HangDetectionMarker = {
  detectedAt: number
  parentPid: number
  unresponsiveMs: number
  selfRecovered: boolean
}

export function hangDetectionMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'main-thread-hang.json')
}

export function writeHangDetectionMarker(markerPath: string, marker: HangDetectionMarker): void {
  writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 })
}

export function readHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  return readAvailableHangDetectionMarker(markerPath) ?? null
}

function readAvailableHangDetectionMarker(
  markerPath: string
): HangDetectionMarker | null | undefined {
  let raw: string
  try {
    if (statSync(markerPath).size > 64 * 1024) {
      return null
    }
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      !parsed ||
      !('detectedAt' in parsed) ||
      typeof parsed.detectedAt !== 'number' ||
      !Number.isFinite(parsed.detectedAt) ||
      !('parentPid' in parsed) ||
      typeof parsed.parentPid !== 'number' ||
      !Number.isInteger(parsed.parentPid) ||
      parsed.parentPid <= 0 ||
      !('unresponsiveMs' in parsed) ||
      typeof parsed.unresponsiveMs !== 'number' ||
      !Number.isFinite(parsed.unresponsiveMs) ||
      parsed.unresponsiveMs < 0
    ) {
      return null
    }
    return {
      detectedAt: parsed.detectedAt,
      parentPid: parsed.parentPid,
      unresponsiveMs: parsed.unresponsiveMs,
      // Why: a marker left by the detect leg and never rewritten means the stall never cleared.
      selfRecovered: 'selfRecovered' in parsed && parsed.selfRecovered === true
    }
  } catch {
    return null
  }
}

export function consumeHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  const marker = readAvailableHangDetectionMarker(markerPath)
  // Retry unavailable reads next startup; only successfully inspected files are consumable.
  if (marker === undefined) {
    return null
  }
  try {
    rmSync(markerPath, { force: true })
  } catch {
    // A marker that cannot be deleted may produce a duplicate breadcrumb, but cannot block startup.
  }
  return marker
}
