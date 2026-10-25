import { getSystemLanguageDetection } from '../i18n/system-language'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AppIdentity } from '../../shared/app-identity'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import { relaunchApp, runBeforeRelaunchCleanup } from '../app-relaunch'
import { prepareWindowsAdministratorRestart } from '../windows/windows-administrator-restart'
import { quitProcess } from '../startup/process-quit-request'
import type { Store } from '../persistence'
import { getDevInstanceIdentity } from '../startup/dev-instance-identity'
import { isPwshAvailableAsync } from '../pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../wsl'
import { isGitBashAvailable } from '../git-bash'
import { setUnreadDockBadgeCount } from '../dock/unread-badge'
import { destroySystemTray, rebuildSystemTrayMenu } from '../tray/system-tray'
import {
  ensureDefaultFloatingWorkspacePath,
  trustFloatingWorkspaceDirectory,
  resolveFloatingTerminalCwd
} from './floating-workspace-directory'
import {
  isMarkdownDocumentName,
  markdownDocumentFromFilePath
} from '../../shared/markdown-document-paths'
import { registerMacSymbolicHotkeysProbeHandler } from './macos-symbolic-hotkeys-probe'
import {
  registerRendererShutdownCheckpointHandler,
  type QuitResumeRecordsFor
} from './renderer-shutdown-checkpoint'
import { readMacKeyboardLayoutSnapshot } from './macos-keyboard-layout-snapshot'
import { registerMacKeyboardLayoutChangeNotifications } from './macos-keyboard-layout-change-notifications'
import { isProfileStateSaveDelayed } from '../startup/profile-state-save-delay'
import { readCommandStdout, readKeyboardInputSourceId } from './macos-keyboard-input-source'
import { getWindowsAdministratorStatus } from '../windows/windows-administrator-status'

import type { ReconnectFactsFor } from '../persistence/window-save-view'

type RegisterAppHandlersOptions = {
  quitResumeRecordsFor?: QuitResumeRecordsFor
  reconnectFactsFor?: ReconnectFactsFor
  onBeforeRelaunch?: () => void | Promise<void>
  /** Only for app:relaunch, whose app.exit(0) is committed and skips will-quit. */
  onBeforeRelaunchExit?: () => void | Promise<void>
}

async function pickFloatingMarkdownDocument(
  event: IpcMainInvokeEvent
): Promise<MarkdownDocument | null> {
  const cwd = await ensureDefaultFloatingWorkspacePath()
  const options = {
    defaultPath: cwd,
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'markdown'] }]
  } satisfies Electron.OpenDialogOptions
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const filePath = result.filePaths[0]
  if (!isMarkdownDocumentName(filePath)) {
    throw new Error('Selected file is not a markdown document.')
  }
  return markdownDocumentFromFilePath(cwd, filePath, { outsideRootRelativePath: 'basename' })
}

async function pickFloatingWorkspaceDirectory(
  event: IpcMainInvokeEvent,
  store: Store
): Promise<string | null> {
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  const options = {
    // Creation belongs to explicit file actions; this picker selects existing directories.
    properties: ['openDirectory']
  } satisfies Electron.OpenDialogOptions
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const selectedDir = result.filePaths[0]
  // Only picker-approved paths may become the floating terminal cwd.
  await trustFloatingWorkspaceDirectory(store, selectedDir)
  return selectedDir
}

function getFeatureWallAssetBaseUrl(): string {
  const assetDir = app.isPackaged
    ? path.join(process.resourcesPath, 'onboarding', 'feature-wall')
    : resolveDevFeatureWallAssetDir()

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const vitePath = assetDir.split(path.sep).join('/')
    const absoluteVitePath = vitePath.startsWith('/') ? vitePath : `/${vitePath}`
    // Dev HTTP origins cannot load file images; serve media through Vite /@fs.
    return new URL(`/@fs${absoluteVitePath}/`, process.env.ELECTRON_RENDERER_URL).toString()
  }

  return `${pathToFileURL(assetDir).toString()}/`
}

function resolveDevFeatureWallAssetDir(): string {
  const relativeDir = path.join('resources', 'onboarding', 'feature-wall')
  const candidates = [
    path.join(app.getAppPath(), relativeDir),
    path.resolve(app.getAppPath(), '..', '..', relativeDir),
    path.join(process.cwd(), relativeDir)
  ]

  // E2E app paths can be out/main while resources remain at the repository root.
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function registerAppHandlers(store: Store, options: RegisterAppHandlersOptions = {}): void {
  registerRendererShutdownCheckpointHandler(
    store,
    options.quitResumeRecordsFor,
    options.reconnectFactsFor
  )
  registerMacKeyboardLayoutChangeNotifications()
  ipcMain.handle('app:isProfileStateSaveDelayed', isProfileStateSaveDelayed)
  ipcMain.handle('app:getSystemLanguageDetection', (_event, preferences: unknown) => {
    const previous = getSystemLanguageDetection()
    const detection = getSystemLanguageDetection(
      Array.isArray(preferences) && preferences.every((tag) => typeof tag === 'string')
        ? preferences
        : undefined
    )
    if (detection !== previous && store.getSettings().uiLanguage === 'system') {
      void setMainUiLanguage('system')
        .then(() => {
          rebuildAppMenu()
          rebuildSystemTrayMenu()
        })
        .catch((error) => console.warn('[app] failed to refresh system language menus:', error))
    }
    return detection
  })
  ipcMain.handle('app:getWindowsAdministratorStatus', getWindowsAdministratorStatus)

  ipcMain.handle('app:getFeatureWallAssetBaseUrl', (): string => getFeatureWallAssetBaseUrl())

  ipcMain.handle('app:getIdentity', (): AppIdentity => {
    const identity = getDevInstanceIdentity(!app.isPackaged)
    return {
      name: identity.name,
      isDev: identity.isDev,
      devLabel: identity.devLabel,
      devBranch: identity.devBranch,
      devWorktreeName: identity.devWorktreeName,
      devRepoRoot: identity.devRepoRoot,
      dockBadgeLabel: identity.dockBadgeLabel
    }
  })

  // Async probes avoid blocking PTY traffic and IPC for up to 5s per capability read.
  ipcMain.handle('wsl:isAvailable', (): Promise<boolean> => isWslAvailableAsync())
  ipcMain.handle('wsl:listDistros', (): Promise<string[]> => listWslDistrosAsync())
  ipcMain.handle('pwsh:isAvailable', (): Promise<boolean> => isPwshAvailableAsync())
  ipcMain.handle('gitBash:isAvailable', (): boolean => isGitBashAvailable())

  // The selected IME identity must win over its US-shaped backing keyboard layout.
  ipcMain.handle('app:getKeyboardInputSourceId', async (): Promise<string | null> => {
    if (process.platform !== 'darwin') {
      return null
    }
    try {
      // Focus-in probes must not block the main loop.
      const stdout = await readKeyboardInputSourceId()
      const trimmed = stdout?.trim() ?? ''
      return trimmed.length > 0 ? trimmed : null
    } catch {
      // A failed probe must not promote an IME's backing layout into an Alt default.
      return null
    }
  })

  ipcMain.handle('app:getKeyboardLayoutSnapshot', () => readMacKeyboardLayoutSnapshot())

  ipcMain.handle('app:relaunch', async () => {
    // Delay teardown so the renderer can paint Restarting after cleanup.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    await runBeforeRelaunchCleanup(options.onBeforeRelaunchExit)
    setTimeout(() => {
      // app.exit skips before-quit; remove the Windows tray to avoid a stale icon.
      destroySystemTray()
      relaunchApp('renderer-request')
      app.exit(0)
    }, 150)
  })

  ipcMain.handle('app:restart', async () => {
    // Normal quit flushes daemon checkpoints and telemetry.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    setTimeout(() => {
      relaunchApp('admin-restart')
      quitProcess()
    }, 150)
  })

  ipcMain.handle('app:restartAsAdministrator', async () => {
    const relaunchOptions = prepareWindowsAdministratorRestart()
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    setTimeout(() => {
      relaunchApp('windows-administrator', undefined, relaunchOptions)
      quitProcess()
    }, 150)
  })

  registerMacSymbolicHotkeysProbeHandler(readCommandStdout)

  ipcMain.handle('app:setUnreadDockBadgeCount', (_event, count: number) => {
    setUnreadDockBadgeCount(Number.isFinite(count) ? count : 0)
  })

  ipcMain.handle('app:getFloatingTerminalCwd', (_event, args?: FloatingTerminalCwdRequest) =>
    resolveFloatingTerminalCwd(store, args)
  )

  ipcMain.handle('app:getFloatingMarkdownDirectory', () => ensureDefaultFloatingWorkspacePath())

  ipcMain.handle('app:pickFloatingMarkdownDocument', (event) => pickFloatingMarkdownDocument(event))

  ipcMain.handle('app:pickFloatingWorkspaceDirectory', (event) =>
    pickFloatingWorkspaceDirectory(event, store)
  )
}
