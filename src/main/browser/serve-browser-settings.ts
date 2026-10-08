import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

export const DEFAULT_SERVE_BROWSER_PAINT_MODE = 'auto' as const
export const DEFAULT_SERVE_BROWSER_IDLE_SLEEP_SECONDS = 600

type ServeBrowserSettings = {
  serveBrowserPaintMode?: unknown
  serveBrowserIdleSleepSeconds?: unknown
}

// Why a resolver: the live settings store lives in index.ts; subsystems get it injected
// (same pattern as rateLimits resolvers). The persisted-file fallback covers pre-store calls.
let settingsResolver: (() => ServeBrowserSettings | undefined) | null = null
let persistedRead = false
let persistedSettings: ServeBrowserSettings = {}

export function setServeBrowserSettingsResolver(
  resolver: () => ServeBrowserSettings | undefined
): void {
  settingsResolver = resolver
}

function currentSettings(): ServeBrowserSettings {
  const resolved = settingsResolver?.()
  if (resolved) {
    return resolved
  }
  if (!persistedRead) {
    persistedRead = true
    persistedSettings = readPersistedServeBrowserSettings()
  }
  return persistedSettings
}

function readPersistedServeBrowserSettings(): ServeBrowserSettings {
  try {
    const dataFile = join(getAppEnvironment().getPath('userData'), 'orca-data.json')
    if (!existsSync(dataFile)) {
      return {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: persisted orca-data.json; the resolvers below validate each field and fall back to defaults.
    const parsed = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
      settings?: ServeBrowserSettings
    }
    return parsed.settings ?? {}
  } catch {
    return {}
  }
}

export function resolveServeBrowserPaintMode(): 'auto' | 'always' {
  return currentSettings().serveBrowserPaintMode === 'always' ? 'always' : 'auto'
}

export function resolveServeBrowserIdleSleepSeconds(): number {
  const value = currentSettings().serveBrowserIdleSleepSeconds
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_SERVE_BROWSER_IDLE_SLEEP_SECONDS
}
