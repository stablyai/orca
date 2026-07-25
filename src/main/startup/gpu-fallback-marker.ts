import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampGpuFallbackTier, type GpuFallbackTier } from './gpu-fallback-tiers'

/**
 * Persisted "degrade the GPU path for this build" marker.
 *
 * Why a standalone file (not the Store): app.disableHardwareAcceleration() must
 * be called before app.whenReady() resolves, but the settings Store is only
 * constructed inside whenReady. A tiny JSON marker in userData can be read
 * synchronously during early startup, mirroring windows-user-data-acl.ts.
 *
 * The marker is only ever removed when it is provably obsolete. A marker that
 * exists but cannot be read (EPERM/EBUSY/EACCES) is preserved: deleting it
 * silently re-armed hardware acceleration on machines that crash on GPU init.
 */

export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json'
const GPU_FALLBACK_MARKER_TEMP_FILE = 'gpu-fallback.json.tmp'
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
  tier: GpuFallbackTier
  appVersion: string
  electronVersion: string
  platform: 'win32'
}

export type GpuFallbackMarkerReadResult =
  | { status: 'ok'; marker: GpuFallbackMarker }
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'unreadable'; errorCode: string }

/** Why the marker did not apply, so callers can breadcrumb the clear instead of losing it silently. */
export type GpuFallbackMarkerClearedReason = 'invalid' | 'stale-build' | 'non-windows'

export type ActiveGpuFallbackMarkerResult = {
  marker: GpuFallbackMarker | null
  cleared: GpuFallbackMarkerClearedReason | null
  /** Set when the marker exists but could not be read; the file is kept on disk. */
  unreadableErrorCode: string | null
}

const ABSENT_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR'])

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

export function readGpuFallbackMarkerResult(userDataPath: string): GpuFallbackMarkerReadResult {
  let contents: string
  try {
    contents = readFileSync(markerPath(userDataPath), 'utf-8')
  } catch (error) {
    const code = errorCode(error)
    if (code !== undefined && ABSENT_ERROR_CODES.has(code)) {
      return { status: 'absent' }
    }
    return { status: 'unreadable', errorCode: code ?? 'UNKNOWN' }
  }

  let parsed: Partial<Record<keyof GpuFallbackMarker, unknown>>
  try {
    parsed = JSON.parse(contents) as Partial<Record<keyof GpuFallbackMarker, unknown>>
  } catch {
    return { status: 'invalid' }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 'invalid' }
  }
  if (parsed.schemeVersion !== GPU_FALLBACK_SCHEME_VERSION) {
    return { status: 'invalid' }
  }
  if (
    typeof parsed.engagedAt !== 'number' ||
    !Number.isFinite(parsed.engagedAt) ||
    typeof parsed.crashesInWindow !== 'number' ||
    !Number.isFinite(parsed.crashesInWindow) ||
    typeof parsed.appVersion !== 'string' ||
    typeof parsed.electronVersion !== 'string' ||
    parsed.platform !== 'win32'
  ) {
    return { status: 'invalid' }
  }
  return {
    status: 'ok',
    marker: {
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      engagedAt: parsed.engagedAt,
      crashesInWindow: parsed.crashesInWindow,
      tier: clampGpuFallbackTier(parsed.tier),
      appVersion: parsed.appVersion,
      electronVersion: parsed.electronVersion,
      platform: parsed.platform
    }
  }
}

export function readGpuFallbackMarker(userDataPath: string): GpuFallbackMarker | null {
  const result = readGpuFallbackMarkerResult(userDataPath)
  return result.status === 'ok' ? result.marker : null
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; tier: GpuFallbackTier },
  environment: WindowsGpuFallbackEnvironment
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    tier: info.tier,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32'
  }
  // Why: this write races the crash burst that triggered it — a torn marker
  // reads as invalid and silently re-arms hardware acceleration next launch.
  const tempPath = join(userDataPath, GPU_FALLBACK_MARKER_TEMP_FILE)
  try {
    writeFileSync(tempPath, JSON.stringify(marker))
    renameSync(tempPath, markerPath(userDataPath))
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // best effort; a stray temp file is inert
    }
    throw error
  }
}

export function clearGpuFallbackMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // best effort; a stale marker is revalidated on the next launch
  }
}

export function readActiveGpuFallbackMarker(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): ActiveGpuFallbackMarkerResult {
  const result = readGpuFallbackMarkerResult(userDataPath)
  if (result.status === 'absent') {
    return { marker: null, cleared: null, unreadableErrorCode: null }
  }
  if (result.status === 'unreadable') {
    // Why: keep the file. A transient EPERM/EBUSY must not be read as "this
    // machine is healthy" — that is what turned the fallback into a crash loop.
    return { marker: null, cleared: null, unreadableErrorCode: result.errorCode }
  }
  if (result.status === 'invalid') {
    clearGpuFallbackMarker(userDataPath)
    return { marker: null, cleared: 'invalid', unreadableErrorCode: null }
  }
  const { marker } = result
  if (environment.platform !== 'win32' || marker.platform !== environment.platform) {
    clearGpuFallbackMarker(userDataPath)
    return { marker: null, cleared: 'non-windows', unreadableErrorCode: null }
  }
  if (
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    // Why: the marker is sticky only for the build that observed the driver
    // crash burst; updates get one fresh hardware attempt automatically.
    clearGpuFallbackMarker(userDataPath)
    return { marker: null, cleared: 'stale-build', unreadableErrorCode: null }
  }
  return { marker, cleared: null, unreadableErrorCode: null }
}
