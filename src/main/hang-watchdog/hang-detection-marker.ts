import { readFileSync, rmSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Why: written by the watchdog worker when main-thread heartbeats stop, and rewritten if
// they resume; consumed on the next launch to report how long the stall lasted and whether it ever
// cleared. `selfRecovered` separates a real deadlock from a long-but-survivable stall — the two are
// indistinguishable at detection time, and only the latter would have been a destructive kill.
export type HangDetectionMarker = {
  detectedAt: number
  /** Stable episode id; equal to detectedAt for new markers. */
  detectedAtMs?: number
  parentPid: number
  unresponsiveMs: number
  selfRecovered: boolean
  census?: Record<string, number>
}

export function hangDetectionMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'main-thread-hang.json')
}

export function writeHangDetectionMarker(markerPath: string, marker: HangDetectionMarker): void {
  writeFileSync(markerPath, JSON.stringify(marker))
}

/** Atomically claims a marker for recovery-time reporting. The destination is unique per episode. */
export function claimHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  let marker: HangDetectionMarker | null = null
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as HangDetectionMarker
    const id = typeof marker.detectedAtMs === 'number' ? marker.detectedAtMs : marker.detectedAt
    const claimedPath = `${markerPath.replace(/\.json$/, '')}.claimed.${id}.json`
    if (existsSync(claimedPath)) {
      return null
    }
    renameSync(markerPath, claimedPath)
    return marker
  } catch {
    return null
  }
}

/** Removes a claim after the live process has delivered its observation. */
export function removeClaimedHangDetectionMarker(markerPath: string, episodeId: number): void {
  try {
    rmSync(`${markerPath.replace(/\.json$/, '')}.claimed.${episodeId}.json`, { force: true })
  } catch {
    // Best effort; startup cleanup handles claims left by an interrupted delivery.
  }
}

export function consumeHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  // Recovery claims use unique names; prefer the claimed episode and then the legacy marker.
  try {
    const prefix = `${basename(markerPath, '.json')}.claimed.`
    const claimed = readdirSync(dirname(markerPath)).filter((name) => name.startsWith(prefix))
    if (claimed.length > 0) {
      const candidate = claimed.sort().at(0)!
      const claimedMarker = consumeHangDetectionMarker(join(dirname(markerPath), candidate))
      if (claimedMarker) {
        return claimedMarker
      }
    }
  } catch {
    // Ignore directory races.
  }
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
    const result: HangDetectionMarker = {
      detectedAt: parsed.detectedAt,
      parentPid: parsed.parentPid,
      unresponsiveMs: parsed.unresponsiveMs,
      // Why: a marker left by the detect leg and never rewritten means the stall never cleared.
      selfRecovered: parsed.selfRecovered === true
    }
    if (typeof parsed.detectedAtMs === 'number') {
      result.detectedAtMs = parsed.detectedAtMs
    }
    if (parsed.census && typeof parsed.census === 'object') {
      result.census = parsed.census as Record<string, number>
    }
    return result
  } catch {
    return null
  }
}
