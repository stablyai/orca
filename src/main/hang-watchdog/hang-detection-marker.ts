import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  writeFileSync(markerPath, JSON.stringify(marker))
}

export function consumeHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return null
  }
  try {
    rmSync(markerPath, { force: true })
  } catch {
    // Why: a marker that cannot be deleted must not block startup; worst case is one duplicate breadcrumb.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HangDetectionMarker>
    if (
      typeof parsed.detectedAt !== 'number' ||
      typeof parsed.parentPid !== 'number' ||
      typeof parsed.unresponsiveMs !== 'number'
    ) {
      return null
    }
    return {
      detectedAt: parsed.detectedAt,
      parentPid: parsed.parentPid,
      unresponsiveMs: parsed.unresponsiveMs,
      // Why: a marker left by the detect leg and never rewritten means the stall never cleared.
      selfRecovered: parsed.selfRecovered === true
    }
  } catch {
    return null
  }
}
