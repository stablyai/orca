import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { app, shell } from 'electron'

import { getWindowsProgramsPath } from './windows-programs-path'

type ReadShortcutLink = (shortcutPath: string) => Electron.ShortcutDetails
type WriteShortcutLink = (
  shortcutPath: string,
  operation: 'update',
  options: Electron.ShortcutDetails
) => boolean

type UpdateWindowsAppShortcutIconOptions = {
  appDataPath?: string
  appName?: string
  desktopPath?: string
  executablePath?: string
  getProgramsPath?: () => string
  isPackaged?: boolean
  pathExists?: (shortcutPath: string) => boolean
  platform?: NodeJS.Platform
  readShortcutLink?: ReadShortcutLink
  writeShortcutLink?: WriteShortcutLink
}

type WindowsAppShortcutIconUpdateResult = {
  failedPaths: string[]
  updatedPaths: string[]
}

function normalizeWindowsExecutablePath(value: string): string {
  return win32.normalize(value).toLowerCase()
}

function getOwnedShortcutPaths(
  options: Required<Pick<UpdateWindowsAppShortcutIconOptions, 'appName' | 'desktopPath'>> & {
    programsPath: string
  }
): string[] {
  const shortcutName = `${options.appName}.lnk`
  // Why: the per-user NSIS installer owns these Start Menu and Desktop launchers;
  // pinned taskbar shortcuts are Shell-managed and must not be rewritten in place.
  return [
    win32.join(options.programsPath, shortcutName),
    win32.join(options.desktopPath, shortcutName)
  ]
}

export function updateWindowsAppShortcutIcon(
  iconPath: string,
  options: UpdateWindowsAppShortcutIconOptions = {}
): WindowsAppShortcutIconUpdateResult {
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged ?? app.isPackaged
  const result: WindowsAppShortcutIconUpdateResult = { failedPaths: [], updatedPaths: [] }
  if (platform !== 'win32' || !isPackaged) {
    return result
  }

  const appName = options.appName ?? app.getName()
  const appDataPath = options.appDataPath ?? app.getPath('appData')
  const desktopPath = options.desktopPath ?? app.getPath('desktop')
  const executablePath = options.executablePath ?? process.execPath
  const pathExists = options.pathExists ?? existsSync
  const readShortcutLink = options.readShortcutLink ?? shell.readShortcutLink.bind(shell)
  const writeShortcutLink = options.writeShortcutLink ?? shell.writeShortcutLink.bind(shell)

  let programsPath: string
  try {
    programsPath = (options.getProgramsPath ?? getWindowsProgramsPath)()
  } catch (error) {
    // Why: failure to query the redirectable known folder must not block saving
    // the icon choice; the documented default remains a safe compatibility path.
    console.warn('[app-icon] failed to resolve FOLDERID_Programs:', error)
    programsPath = win32.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  }

  for (const shortcutPath of getOwnedShortcutPaths({ appName, desktopPath, programsPath })) {
    if (!pathExists(shortcutPath)) {
      continue
    }
    try {
      const current = readShortcutLink(shortcutPath)
      // Why: users may replace an installer-created shortcut with an unrelated
      // target that happens to have the same name; never rewrite that shortcut.
      if (
        normalizeWindowsExecutablePath(current.target) !==
        normalizeWindowsExecutablePath(executablePath)
      ) {
        continue
      }
      const updated = writeShortcutLink(shortcutPath, 'update', {
        ...current,
        icon: iconPath,
        iconIndex: 0
      })
      if (updated) {
        result.updatedPaths.push(shortcutPath)
      } else {
        result.failedPaths.push(shortcutPath)
      }
    } catch (error) {
      // Why: a locked or policy-managed shortcut must not prevent saving the
      // icon choice; users can still re-pin the running app after restart.
      console.warn(`[app-icon] failed to update Windows shortcut ${shortcutPath}:`, error)
      result.failedPaths.push(shortcutPath)
    }
  }
  return result
}
