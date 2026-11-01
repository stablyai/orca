import { win32 } from 'node:path'

// NSIS updates install to the registry's InstallLocation, which a moved install leaves pointing at the
// default per-user folder; pass the running folder as /D= so the update replaces the copy the user runs.
export function pinWindowsUpdateInstallDirectory(
  autoUpdater: object,
  platform: NodeJS.Platform,
  exePath: string
): void {
  if (platform !== 'win32') {
    return
  }
  // NsisUpdater reads installDirectory, which the cross-platform AppUpdater type omits.
  Object.assign(autoUpdater, { installDirectory: win32.dirname(exePath) })
}
