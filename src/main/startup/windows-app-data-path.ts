import { mkdirSync } from 'node:fs'
import { win32 } from 'node:path'

export type WindowsAppDataPathHost = {
  getPath(name: 'appData'): string
  setPath(name: 'appData' | 'userData', value: string): void
  getName(): string
  commandLine: { hasSwitch(name: string): boolean }
}

/** Derives the roaming AppData folder from the environment when the known-folder lookup fails. */
export function deriveWindowsAppDataPath(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA?.trim()
  if (appData && win32.isAbsolute(appData)) {
    return appData
  }
  const userProfile = env.USERPROFILE?.trim()
  if (userProfile && win32.isAbsolute(userProfile)) {
    return win32.join(userProfile, 'AppData', 'Roaming')
  }
  throw new Error(
    'Orca could not find the Windows roaming AppData folder: Windows did not report it, and neither APPDATA nor USERPROFILE is set.'
  )
}

function readNativeAppDataPath(host: WindowsAppDataPathHost): string | null {
  try {
    return host.getPath('appData') || null
  } catch {
    return null
  }
}

/**
 * Pins appData and userData before anything resolves userData on Windows.
 *
 * Why: when Electron cannot resolve or create userData itself (no loaded profile, e.g. over SSH), it falls
 * through to Chromium's provider, which dereferences null and crashes natively before crashpad connects.
 */
export function ensureWindowsAppDataPath(
  host: WindowsAppDataPathHost,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    return
  }
  let appData = readNativeAppDataPath(host)
  if (!appData) {
    appData = deriveWindowsAppDataPath(env)
    mkdirSync(appData, { recursive: true })
    host.setPath('appData', appData)
  }
  // Electron already resolved userData from an explicit switch; pinning it would override that.
  if (host.commandLine.hasSwitch('user-data-dir')) {
    return
  }
  // Same value Electron's own provider computes; setting it skips that provider entirely.
  host.setPath('userData', win32.join(appData, host.getName()))
}
