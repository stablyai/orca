import {
  execFile as execFileChildProcess,
  type ChildProcess,
  type ExecFileOptions
} from 'node:child_process'
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

type MacDockIconChildProcess = Pick<ChildProcess, 'kill' | 'once'>

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

const MAC_DOCK_ICON_CLEAR_SCRIPT = [
  'use framework "AppKit"',
  'use scripting additions',
  'set appPath to system attribute "ORCA_APP_BUNDLE_PATH"',
  "set ok to current application's NSWorkspace's sharedWorkspace()'s setIcon:(missing value) forFile:appPath options:0",
  'if ok is false then error "Orca app icon could not be cleared"'
]

const MAC_DOCK_ICON_COMMAND_TIMEOUT_MS = 10_000
const MAC_DOCK_ICON_COMMAND_FALLBACK_MS = 1_000

const defaultExecFile: ExecFile = (file, args, optionsOrCallback, callback) => {
  if (typeof optionsOrCallback === 'function') {
    return execFileChildProcess(file, args, optionsOrCallback)
  }
  return execFileChildProcess(file, args, optionsOrCallback, callback ?? (() => {}))
}

let macDockIconPersistenceGeneration = 0
let macDockIconPersistenceQueue = Promise.resolve()

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
): Promise<void> {
  return runBoundedMacDockIconCommand({
    args: MAC_DOCK_ICON_SCRIPT.flatMap((line) => ['-e', line]),
    execFile,
    file: '/usr/bin/osascript',
    onError: (error) => {
      console.warn('[app-icon] failed to persist macOS dock icon:', error)
    },
    options: {
      env: {
        ...process.env,
        ORCA_APP_BUNDLE_PATH: appBundlePath,
        ORCA_APP_ICON_PATH: iconPath
      }
    },
    timeoutWarning: '[app-icon] timed out persisting macOS dock icon'
  })
}

type BoundedMacDockIconCommandOptions = {
  args: string[]
  execFile: ExecFile
  file: string
  onError: (error: Error) => void
  options?: ExecFileOptions
  timeoutWarning: string
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isMacDockIconChildProcess(value: unknown): value is MacDockIconChildProcess {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kill' in value &&
    typeof value.kill === 'function' &&
    'once' in value &&
    typeof value.once === 'function'
  )
}

function runBoundedMacDockIconCommand({
  args,
  execFile,
  file,
  onError,
  options,
  timeoutWarning
}: BoundedMacDockIconCommandOptions): Promise<void> {
  return new Promise((resolve) => {
    let childProcess: MacDockIconChildProcess | undefined
    let settled = false
    let forceFallback: NodeJS.Timeout | undefined

    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(fallback)
      if (forceFallback) {
        clearTimeout(forceFallback)
      }
      if (error) {
        onError(error)
      }
      resolve()
    }

    const finishAfterFallback = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceFallback) {
        clearTimeout(forceFallback)
      }
      console.warn(timeoutWarning)
      resolve()
    }

    const fallback = setTimeout(() => {
      if (settled) {
        return
      }
      if (!childProcess) {
        finishAfterFallback()
        return
      }
      // Why: the queue must not release while an older icon process can still win.
      childProcess.once('exit', finishAfterFallback)
      childProcess.once('close', finishAfterFallback)
      forceFallback = setTimeout(finishAfterFallback, MAC_DOCK_ICON_COMMAND_FALLBACK_MS)
      childProcess.kill()
    }, MAC_DOCK_ICON_COMMAND_TIMEOUT_MS + MAC_DOCK_ICON_COMMAND_FALLBACK_MS)

    try {
      const maybeChildProcess = execFile(
        file,
        args,
        {
          ...options,
          timeout: MAC_DOCK_ICON_COMMAND_TIMEOUT_MS
        },
        finish
      )
      if (isMacDockIconChildProcess(maybeChildProcess)) {
        childProcess = maybeChildProcess
      }
    } catch (error) {
      finish(toError(error))
    }
  })
}

function handleMacDockIconQueueError(error: unknown): void {
  console.warn('[app-icon] failed to persist macOS dock icon:', error)
}

function enqueueMacDockIconPersistence(work: () => Promise<void>): void {
  macDockIconPersistenceQueue = macDockIconPersistenceQueue
    .catch(handleMacDockIconQueueError)
    .then(work)
    .catch(handleMacDockIconQueueError)
}

function clearMacCustomIconMetadata(execFile: ExecFile, appBundlePath: string): Promise<void> {
  const clearAppKitIcon = (): Promise<void> => {
    return runBoundedMacDockIconCommand({
      args: MAC_DOCK_ICON_CLEAR_SCRIPT.flatMap((line) => ['-e', line]),
      execFile,
      file: '/usr/bin/osascript',
      onError: (error) => {
        console.warn('[app-icon] failed to clear macOS dock icon:', error)
      },
      options: {
        env: {
          ...process.env,
          ORCA_APP_BUNDLE_PATH: appBundlePath
        }
      },
      timeoutWarning: '[app-icon] timed out clearing macOS dock icon'
    })
  }

  const clearAttribute = (attribute: string): Promise<void> => {
    return runBoundedMacDockIconCommand({
      args: ['-d', attribute, appBundlePath],
      execFile,
      file: '/usr/bin/xattr',
      onError: (error) => {
        if (!error.message.includes('No such xattr')) {
          console.warn(`[app-icon] failed to clear macOS dock icon metadata ${attribute}:`, error)
        }
      },
      timeoutWarning: `[app-icon] timed out clearing macOS dock icon metadata ${attribute}`
    })
  }

  return clearAppKitIcon().then(() =>
    Promise.all([
      clearAttribute('com.apple.FinderInfo'),
      clearAttribute('com.apple.ResourceFork')
    ]).then(() => {})
  )
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
  const generation = ++macDockIconPersistenceGeneration
  enqueueMacDockIconPersistence(async () => {
    // Why: stale queued writes must not reapply an older Dock pin icon.
    if (generation !== macDockIconPersistenceGeneration) {
      return
    }
    if (iconId === 'classic') {
      await clearMacCustomIconMetadata(execFile, appBundlePath)
      return
    }
    // Why: a stopped app's Dock tile is resolved from Finder metadata, not
    // Electron's live app.dock.setIcon state.
    await runMacCustomIconCommand(execFile, appBundlePath, MAC_DOCK_ICON_PATHS[iconId])
  })
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
