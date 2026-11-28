import { systemPreferences } from 'electron'

// AppKit's AutoFill heuristic runs on every focused text input and, on macOS 27, can take an
// exception inside -[SPSafariPlatformSupport dismissAutoFill] that leaves the main process
// suspended for good. Orca's own inputs never need Safari password AutoFill, so opt out.
// registerDefaults only fills the in-memory registration domain: nothing is written to disk,
// and an explicit `defaults write com.stablyai.orca <key> -bool true` still wins.
export const MAC_AUTOFILL_HEURISTIC_DEFAULTS = {
  NSAutoFillHeuristicControllerEnabled: false,
  NSAutoFillHeuristicsEnabled: false
} as const

export type MacAutoFillHost = {
  platform: NodeJS.Platform
  registerDefaults: (defaults: Record<string, boolean>) => void
}

export function disableMacAutoFillHeuristic(host: MacAutoFillHost): boolean {
  if (host.platform !== 'darwin') {
    return false
  }
  try {
    host.registerDefaults({ ...MAC_AUTOFILL_HEURISTIC_DEFAULTS })
    return true
  } catch (error) {
    console.warn('[autofill] Could not disable the macOS AutoFill heuristic:', error)
    return false
  }
}

export function disableMacAutoFillHeuristicAtStartup(): boolean {
  return disableMacAutoFillHeuristic({
    platform: process.platform,
    registerDefaults: (defaults) => systemPreferences.registerDefaults(defaults)
  })
}
