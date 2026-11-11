import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The next launch consumes detection/resolution markers; selfRecovered distinguishes cleared stalls from unresolved hangs.
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
      // Missing recovery evidence leaves the stall unresolved.
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
