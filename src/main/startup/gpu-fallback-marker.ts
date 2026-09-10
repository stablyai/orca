import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json'
export const GPU_FALLBACK_SCHEME_VERSION = 3

export type GpuFallbackEnvironment = {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type WindowsGpuFallbackEnvironment = GpuFallbackEnvironment & { platform: 'win32' }
export type LinuxGpuFallbackEnvironment = GpuFallbackEnvironment & { platform: 'linux' }
export type GpuFallbackMarkerPlatform = 'win32' | 'linux'

export type GpuFallbackMarker = {
  schemeVersion: number
  engagedAt: number
  crashesInWindow: number
  userConfirmed: boolean
  appVersion: string
  electronVersion: string
  platform: GpuFallbackMarkerPlatform
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE)
}

export function readGpuFallbackMarker(userDataPath: string): GpuFallbackMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof GpuFallbackMarker, unknown>
    >
    if (
      parsed.schemeVersion !== GPU_FALLBACK_SCHEME_VERSION ||
      typeof parsed.engagedAt !== 'number' ||
      !Number.isFinite(parsed.engagedAt) ||
      typeof parsed.crashesInWindow !== 'number' ||
      !Number.isFinite(parsed.crashesInWindow) ||
      typeof parsed.userConfirmed !== 'boolean' ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      (parsed.platform !== 'win32' && parsed.platform !== 'linux')
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
    return null
  }
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; userConfirmed?: boolean },
  environment: WindowsGpuFallbackEnvironment | LinuxGpuFallbackEnvironment
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    userConfirmed: info.userConfirmed ?? environment.platform === 'linux',
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
    marker.platform !== environment.platform ||
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    clearGpuFallbackMarker(userDataPath)
    return null
  }
  return marker
}
