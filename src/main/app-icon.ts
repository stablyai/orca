import { execFile as execFileChildProcess, type ExecFileOptions } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import classicIcon from '../../resources/icon.png?asset'
import classicDevIcon from '../../resources/icon-dev.png?asset'
import watercolorIcon from '../../resources/app-icons/orca-watercolor.png?asset'
import watercolorMacDockIcon from '../../resources/app-icons/orca-watercolor.png?asset&asarUnpack'
import blueIcon from '../../resources/app-icons/orca-blue.png?asset'
import blueMacDockIcon from '../../resources/app-icons/orca-blue.png?asset&asarUnpack'
import { normalizeAppIconId, type AppIconId } from '../shared/app-icon'

const APP_ICON_PATHS = {
  classic: is.dev ? classicDevIcon : classicIcon,
  watercolor: watercolorIcon,
  blue: blueIcon
} satisfies Record<AppIconId, string>

const MAC_DOCK_ICON_PATHS = {
  watercolor: watercolorMacDockIcon,
  blue: blueMacDockIcon
} satisfies Record<Exclude<AppIconId, 'classic'>, string>

type ExecFile = (
  file: string,
  args: string[],
  optionsOrCallback: ExecFileOptions | ((error: Error | null) => void),
  callback?: (error: Error | null) => void
) => unknown

type PersistMacDockIconOptions = {
  appBundlePath?: string
  execFile?: ExecFile
  isDevApp?: boolean
  platform?: NodeJS.Platform
}

const MAC_DOCK_ICON_SCRIPT = [
  'use framework "AppKit"',
  'use scripting additions',
  'set appPath to system attribute "ORCA_APP_BUNDLE_PATH"',
  'set iconPath to system attribute "ORCA_APP_ICON_PATH"',
  "set image to current application's NSImage's alloc()'s initWithContentsOfFile:iconPath",
  'if image is missing value then error "Orca app icon image could not be loaded"',
  "set ok to current application's NSWorkspace's sharedWorkspace()'s setIcon:image forFile:appPath options:0",
  'if ok is false then error "Orca app icon could not be persisted"'
]

const defaultExecFile: ExecFile = (file, args, optionsOrCallback, callback) => {
  if (typeof optionsOrCallback === 'function') {
    return execFileChildProcess(file, args, optionsOrCallback)
  }
  return execFileChildProcess(file, args, optionsOrCallback, callback ?? (() => {}))
}

export function getAppIconPath(value: unknown): string {
  return APP_ICON_PATHS[normalizeAppIconId(value)]
}

export function createAppIconImage(value: unknown): Electron.NativeImage {
  return nativeImage.createFromPath(getAppIconPath(value))
}

function getMacAppBundlePath(): string | undefined {
  const appBundlePath = resolve(dirname(app.getPath('exe')), '..', '..')
  return appBundlePath.endsWith('.app') ? appBundlePath : undefined
}

function runMacCustomIconCommand(
  execFile: ExecFile,
  appBundlePath: string,
  iconPath: string
): void {
  execFile(
    '/usr/bin/osascript',
    MAC_DOCK_ICON_SCRIPT.flatMap((line) => ['-e', line]),
    {
      env: {
        ...process.env,
        ORCA_APP_BUNDLE_PATH: appBundlePath,
        ORCA_APP_ICON_PATH: iconPath
      }
    },
    (error) => {
      if (error) {
        console.warn('[app-icon] failed to persist macOS dock icon:', error)
      }
    }
  )
}

function clearMacCustomIconMetadata(execFile: ExecFile, appBundlePath: string): void {
  execFile('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', appBundlePath], () => {})
  execFile('/usr/bin/xattr', ['-d', 'com.apple.ResourceFork', appBundlePath], () => {})
}

export function persistMacDockIcon(value: unknown, options: PersistMacDockIconOptions = {}): void {
  const platform = options.platform ?? process.platform
  const isDevApp = options.isDevApp ?? (is.dev || !app.isPackaged)
  if (platform !== 'darwin' || isDevApp) {
    return
  }
  const appBundlePath = options.appBundlePath ?? getMacAppBundlePath()
  if (!appBundlePath) {
    return
  }
  const execFile = options.execFile ?? defaultExecFile
  const iconId = normalizeAppIconId(value)
  if (iconId === 'classic') {
    clearMacCustomIconMetadata(execFile, appBundlePath)
    return
  }
  // Why: a stopped app's Dock tile is resolved from Finder metadata, not
  // Electron's live app.dock.setIcon state.
  runMacCustomIconCommand(execFile, appBundlePath, MAC_DOCK_ICON_PATHS[iconId])
}

export function applyAppIcon(value: unknown): void {
  const image = createAppIconImage(value)
  if (image.isEmpty()) {
    return
  }
  if (process.platform === 'darwin') {
    app.dock?.setIcon(image)
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.setIcon(image)
    }
  }
  persistMacDockIcon(value)
}
