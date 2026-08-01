import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurableSync
} from '../durable-file-write'

/**
 * Persisted "disable hardware acceleration for this build" marker.
 *
 * Why a standalone file (not the Store): app.disableHardwareAcceleration() must
 * be called before app.whenReady() resolves, but the settings Store is only
 * constructed inside whenReady. A tiny JSON marker in userData can be read
 * synchronously during early startup, mirroring windows-user-data-acl.ts.
 */

export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json'
// Bumped to 3 for `consented`, which self-invalidates markers written without it.
export const GPU_FALLBACK_SCHEME_VERSION = 3

export type GpuFallbackEnvironment = {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type WindowsGpuFallbackEnvironment = GpuFallbackEnvironment & { platform: 'win32' }

export type GpuFallbackMarker = {
  schemeVersion: number
  engagedAt: number
  crashesInWindow: number
  /** False while the marker is only a pre-prompt latch; true once the user chose to restart. */
  consented: boolean
  appVersion: string
  electronVersion: string
  platform: 'win32'
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE)
}

/** Why exported: the startup temp sweep is gated on a fallback file having existed. */
export function gpuFallbackMarkerFileExists(userDataPath: string): boolean {
  return existsSync(markerPath(userDataPath))
}

export function readGpuFallbackMarker(userDataPath: string): GpuFallbackMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof GpuFallbackMarker, unknown>
    >
    if (parsed.schemeVersion !== GPU_FALLBACK_SCHEME_VERSION) {
      return null
    }
    if (
      typeof parsed.engagedAt !== 'number' ||
      !Number.isFinite(parsed.engagedAt) ||
      typeof parsed.crashesInWindow !== 'number' ||
      !Number.isFinite(parsed.crashesInWindow) ||
      typeof parsed.consented !== 'boolean' ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      parsed.platform !== 'win32'
    ) {
      return null
    }
    return {
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      engagedAt: parsed.engagedAt,
      crashesInWindow: parsed.crashesInWindow,
      consented: parsed.consented,
      appVersion: parsed.appVersion,
      electronVersion: parsed.electronVersion,
      platform: parsed.platform
    }
  } catch {
    // missing or corrupt means no fallback requested
  }
  return null
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; consented: boolean },
  environment: WindowsGpuFallbackEnvironment
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    consented: info.consented,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32'
  }
  // Why: this write races Chromium's GPU kill (and often a driver TDR), so a bare
  // writeFileSync can leave a truncated file that reads back as "no fallback".
  const target = markerPath(userDataPath)
  const payload = JSON.stringify(marker)
  const tmp = durableWriteTempPath(target)
  try {
    writeFileDurableSync(tmp, target, payload)
  } catch (durableError) {
    // writeFileDurableSync cannot throw once its rename returned (the directory
    // fsync swallows its own errors), so reaching here means nothing was written.
    try {
      // Why: renameSync is EPERM on Windows while an AV/indexer holds the target
      // open, where a direct write still lands. Never end up worse than before.
      writeFileSync(target, payload)
    } catch {
      // Why rethrow the durable error: it names the real cause (EPERM on rename).
      throw durableError
    } finally {
      // Why after the write and without retries: the same handle that refused the
      // rename usually refuses this unlink, and blocking here would push the
      // marker past the kill it exists to survive. Orphans are swept next launch.
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Recoverable: sweepStaleGpuFallbackMarkerTempFiles reclaims it.
      }
    }
  }
}

/** Why: the kill this marker guards against can land between write and rename. */
export async function sweepStaleGpuFallbackMarkerTempFiles(userDataPath: string): Promise<void> {
  await removeStaleDurableWriteTempFiles(markerPath(userDataPath))
}

/**
 * Removes the marker, blocking for a short backoff if Windows refuses the unlink.
 * Returns false when it is still on disk, so callers can report it.
 *
 * Only for callers with no second chance: the terminal `quit` event, and the
 * prompt's "Keep Running" answer. Revalidation on the startup path must not
 * block a window behind an AV hold — it uses `clearMarkerBestEffort`.
 */
export function clearGpuFallbackMarker(userDataPath: string): boolean {
  return removeFileWithRetries(markerPath(userDataPath))
}

/** Why no retry: startup can just revalidate again on the next launch. */
function clearMarkerBestEffort(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // A stale marker is revalidated on the next launch.
  }
}

// Why hand-rolled: rmSync's maxRetries/retryDelay only apply to recursive removals,
// so a single-file unlink gets no retry at all.
const FILE_REMOVE_RETRY_DELAYS_MS = [20, 40, 80]

function removeFileWithRetries(filePath: string): boolean {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(filePath, { force: true })
      return true
    } catch {
      if (!existsSync(filePath)) {
        return true
      }
      if (attempt >= FILE_REMOVE_RETRY_DELAYS_MS.length) {
        return false
      }
      sleepSync(FILE_REMOVE_RETRY_DELAYS_MS[attempt])
    }
  }
}

// Why Atomics.wait: `quit` and the deferred prompt path are synchronous, so a
// timer-based backoff would never run before the process leaves.
function sleepSync(milliseconds: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  } catch {
    // SharedArrayBuffer unavailable: fall through and retry immediately.
  }
}

export function readActiveGpuFallbackMarker(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): GpuFallbackMarker | null {
  const marker = readGpuFallbackMarker(userDataPath)
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) {
      clearMarkerBestEffort(userDataPath)
    }
    return null
  }
  if (
    environment.platform !== 'win32' ||
    marker.platform !== environment.platform ||
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    // Why: the marker is sticky only for the build that observed the driver
    // crash burst; updates get one fresh hardware attempt automatically.
    clearMarkerBestEffort(userDataPath)
    return null
  }
  return marker
}
