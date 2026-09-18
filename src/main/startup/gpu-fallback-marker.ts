import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Persisted "disable hardware acceleration for this build" marker.
 *
 * Why a standalone file (not the Store): app.disableHardwareAcceleration() must
 * be called before app.whenReady() resolves, but the settings Store is only
 * constructed inside whenReady. A tiny JSON marker in userData can be read
 * synchronously during early startup, mirroring windows-user-data-acl.ts.
 */

export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json'
export const GPU_FALLBACK_SCHEME_VERSION = 3

// Why not darwin: enableMainProcessGpuFeatures() carries the macOS
// disable-skia-graphite fix; skipping it under fallback would silently
// strip the fix from Macs.
export type GpuFallbackPlatform = 'win32' | 'linux'

const GPU_FALLBACK_PLATFORMS: ReadonlySet<string> = new Set<GpuFallbackPlatform>(['win32', 'linux'])

export function isGpuFallbackPlatform(value: unknown): value is GpuFallbackPlatform {
  return typeof value === 'string' && GPU_FALLBACK_PLATFORMS.has(value)
}

export type GpuFallbackEnvironment = {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type SupportedGpuFallbackEnvironment = GpuFallbackEnvironment & {
  platform: GpuFallbackPlatform
}

export type GpuFallbackMarker = {
  schemeVersion: number
  engagedAt: number
  crashesInWindow: number
  userConfirmed: boolean
  appVersion: string
  electronVersion: string
  platform: GpuFallbackPlatform
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE)
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
      typeof parsed.userConfirmed !== 'boolean' ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      !isGpuFallbackPlatform(parsed.platform)
    ) {
      return null
    }
    return {
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      engagedAt: parsed.engagedAt,
      crashesInWindow: parsed.crashesInWindow,
      userConfirmed: parsed.userConfirmed,
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
  info: { engagedAt: number; crashesInWindow: number; userConfirmed: boolean },
  environment: SupportedGpuFallbackEnvironment
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    userConfirmed: info.userConfirmed,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: environment.platform
  }
  writeFileSync(markerPath(userDataPath), JSON.stringify(marker))
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
): GpuFallbackMarker | null {
  const marker = readGpuFallbackMarker(userDataPath)
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) {
      clearGpuFallbackMarker(userDataPath)
    }
    return null
  }
  if (
    !isGpuFallbackPlatform(environment.platform) ||
    marker.platform !== environment.platform ||
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    // Why: the marker is sticky only for the build that observed the driver
    // crash burst; updates get one fresh hardware attempt automatically.
    clearGpuFallbackMarker(userDataPath)
    return null
  }
  return marker
}
