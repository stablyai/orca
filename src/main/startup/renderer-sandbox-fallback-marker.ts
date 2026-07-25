import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Persisted "run this build's top-level renderer unsandboxed" marker.
 *
 * Why a standalone file (not the Store): createMainWindow must pick
 * webPreferences.sandbox for the first window, which happens before the settings
 * Store is constructed inside whenReady. A tiny JSON marker in userData reads
 * synchronously during early startup, mirroring gpu-fallback-marker.ts.
 */

export const RENDERER_SANDBOX_FALLBACK_MARKER_FILE = 'renderer-sandbox-fallback.json'
export const RENDERER_SANDBOX_FALLBACK_SCHEME_VERSION = 1

export type RendererSandboxFallbackEnvironment = {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type WindowsRendererSandboxFallbackEnvironment = RendererSandboxFallbackEnvironment & {
  platform: 'win32'
}

export type RendererSandboxFallbackMarker = {
  schemeVersion: number
  engagedAt: number
  crashesInWindow: number
  exitCode: number
  appVersion: string
  electronVersion: string
  platform: 'win32'
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, RENDERER_SANDBOX_FALLBACK_MARKER_FILE)
}

export function readRendererSandboxFallbackMarker(
  userDataPath: string
): RendererSandboxFallbackMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof RendererSandboxFallbackMarker, unknown>
    >
    if (parsed.schemeVersion !== RENDERER_SANDBOX_FALLBACK_SCHEME_VERSION) {
      return null
    }
    if (
      typeof parsed.engagedAt !== 'number' ||
      !Number.isFinite(parsed.engagedAt) ||
      typeof parsed.crashesInWindow !== 'number' ||
      !Number.isFinite(parsed.crashesInWindow) ||
      typeof parsed.exitCode !== 'number' ||
      !Number.isFinite(parsed.exitCode) ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      parsed.platform !== 'win32'
    ) {
      return null
    }
    return {
      schemeVersion: RENDERER_SANDBOX_FALLBACK_SCHEME_VERSION,
      engagedAt: parsed.engagedAt,
      crashesInWindow: parsed.crashesInWindow,
      exitCode: parsed.exitCode,
      appVersion: parsed.appVersion,
      electronVersion: parsed.electronVersion,
      platform: parsed.platform
    }
  } catch {
    // missing or corrupt means no fallback requested
  }
  return null
}

export function writeRendererSandboxFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; exitCode: number },
  environment: WindowsRendererSandboxFallbackEnvironment
): void {
  const marker: RendererSandboxFallbackMarker = {
    schemeVersion: RENDERER_SANDBOX_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    exitCode: info.exitCode,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32'
  }
  writeFileSync(markerPath(userDataPath), JSON.stringify(marker))
}

export function clearRendererSandboxFallbackMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // best effort; a stale marker is revalidated on the next launch
  }
}

export function readActiveRendererSandboxFallbackMarker(
  userDataPath: string,
  environment: RendererSandboxFallbackEnvironment
): RendererSandboxFallbackMarker | null {
  const marker = readRendererSandboxFallbackMarker(userDataPath)
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) {
      clearRendererSandboxFallbackMarker(userDataPath)
    }
    return null
  }
  if (
    environment.platform !== 'win32' ||
    marker.platform !== environment.platform ||
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    // Why: the marker is sticky only for the build that observed the crash
    // burst; updates get one fresh sandboxed attempt automatically.
    clearRendererSandboxFallbackMarker(userDataPath)
    return null
  }
  return marker
}
