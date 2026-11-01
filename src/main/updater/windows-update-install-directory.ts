import { readdirSync } from 'node:fs'
import { win32 } from 'node:path'

const UNINSTALLER_NAME = 'Uninstall Orca.exe'
const INSTALL_DIRECTORIES = new Set(['locales', 'resources'])
const INSTALL_EXECUTABLES = new Set(['orca.exe', UNINSTALLER_NAME.toLowerCase()])
const INSTALL_RUNTIME_FILE = /\.(?:dll|pak|bin|dat|json|html|txt|log)$/i

// The pinned folder becomes InstallLocation, which later updates and uninstalls wipe with RMDir /r;
// pin only a folder holding nothing but an installed Orca layout so no unrelated files are ever deleted.
function isDedicatedOrcaInstallDirectory(directory: string): boolean {
  if (win32.parse(directory).root === directory) {
    return false
  }
  try {
    const entries = readdirSync(directory, { withFileTypes: true })
    if (!entries.some((entry) => entry.isFile() && entry.name === UNINSTALLER_NAME)) {
      return false
    }
    return entries.every((entry) =>
      entry.isDirectory()
        ? INSTALL_DIRECTORIES.has(entry.name.toLowerCase())
        : entry.isFile() &&
          (INSTALL_EXECUTABLES.has(entry.name.toLowerCase()) ||
            INSTALL_RUNTIME_FILE.test(entry.name))
    )
  } catch {
    return false
  }
}

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
  const installDirectory = win32.dirname(exePath)
  // spawn quotes a spaced arg as "/D=...", and NSIS keeps the trailing quote in INSTDIR, breaking the update.
  if (/\s/.test(installDirectory) || !isDedicatedOrcaInstallDirectory(installDirectory)) {
    return
  }
  // NsisUpdater reads installDirectory, which the cross-platform AppUpdater type omits.
  Object.assign(autoUpdater, { installDirectory })
}
