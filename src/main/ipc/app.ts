import { getSystemLanguageDetection } from '../i18n/system-language'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AppIdentity } from '../../shared/app-lifecycle/identity/app-identity'
import type { MarkdownDocument } from '../../shared/file-listing/file-document'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome/ui-chrome-types'
import {
  announceRuntimeRelaunch,
  relaunchApp,
  runBeforeRelaunchCleanup
} from '../startup/quit/app-relaunch'
import { setWindowMaterialSuppressed } from '../window/presentation/window-material-suppression'
import { isTrustedUIRenderer } from './ui'
import { handleAppQuitRequest } from './renderer-requests/app-quit-request'
import { quitProcess } from '../startup/quit/process-quit-request'
import type { Store } from '../persistence/loading-store/store'
import { getDevInstanceIdentity } from '../startup/profile-startup/dev-instance-identity'
import { destroySystemTray, rebuildSystemTrayMenu } from '../tray/system-tray'
import { registerMacSymbolicHotkeysProbeHandler } from './keyboard/macos-symbolic-hotkeys-probe'
import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'
import type { RendererShutdownCheckpointService } from '../core-desktop/renderer-shutdown-checkpoint-service'
import { registerMacKeyboardLayoutChangeNotifications } from './keyboard/macos-keyboard-layout-change-notifications'
import { isProfileStateSaveDelayed } from '../startup/profile-startup/profile-state-save-delay'
import { readCommandStdout } from './keyboard/macos-keyboard-input-source'

type RegisterAppHandlersOptions = {
  rendererCheckpoint: RendererShutdownCheckpointService
  onBeforeRelaunch?: () => void | Promise<void>
  /** Only for app:relaunch, whose app.exit(0) is committed and skips will-quit. */
  onBeforeRelaunchExit?: () => void | Promise<void>
  /** Ordinary user quit, the same path as the app menu and tray Quit. */
  onQuit?: () => void
}

async function pickFloatingMarkdownDocument(
  event: IpcMainInvokeEvent
): Promise<MarkdownDocument | null> {
  const [
    { ensureDefaultFloatingWorkspacePath },
    { isMarkdownDocumentName, markdownDocumentFromFilePath }
  ] = await Promise.all([
    import('./worktrees/floating-workspace-directory'),
    import('../../shared/file-listing/markdown-document-paths')
  ])
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
  const { trustFloatingWorkspaceDirectory } =
    await import('./worktrees/floating-workspace-directory')
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

export function registerAppHandlers(store: Store, options: RegisterAppHandlersOptions): void {
  registerRendererShutdownCheckpointHandler(options.rendererCheckpoint)
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
  ipcMain.handle('app:getWindowsAdministratorStatus', async () => {
    const { getWindowsAdministratorStatus } =
      await import('../windows/windows-administrator-status')
    return getWindowsAdministratorStatus()
  })
  ipcMain.handle('app:getMacosUpgradeSupport', async (_event, minimumMacosVersion: unknown) => {
    const { getMacosUpgradeSupport } =
      await import('../macos-update-requirement/macos-upgrade-support')
    return getMacosUpgradeSupport(minimumMacosVersion)
  })

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
  ipcMain.handle('wsl:isAvailable', async (): Promise<boolean> => {
    const { isWslAvailableAsync } = await import('../wsl/discovery/wsl-availability')
    return isWslAvailableAsync()
  })
  ipcMain.handle('wsl:listDistros', async (): Promise<string[]> => {
    const { listWslDistrosAsync } = await import('../wsl/discovery/distro-catalog')
    return listWslDistrosAsync()
  })
  ipcMain.handle(
    'wsl:resolveMappedDrivePath',
    async (_event, mappedPath: unknown): Promise<string | null> => {
      const { resolveWslMappedDrivePath } = await import('../wsl/filesystem/wsl-mapped-drive-share')
      return resolveWslMappedDrivePath(mappedPath)
    }
  )
  ipcMain.handle('pwsh:isAvailable', async (): Promise<boolean> => {
    const { isPwshAvailableAsync } = await import('../pty/shell-startup/pwsh')
    return isPwshAvailableAsync()
  })
  ipcMain.handle('gitBash:isAvailable', async (): Promise<boolean> => {
    const { isGitBashAvailable } = await import('../pty/shell-startup/git-bash')
    return isGitBashAvailable()
  })

  // The selected IME identity must win over its US-shaped backing keyboard layout.
  ipcMain.handle('app:getKeyboardInputSourceId', async (): Promise<string | null> => {
    if (process.platform !== 'darwin') {
      return null
    }
    try {
      // Focus-in probes must not block the main loop.
      const { readKeyboardInputSourceId } = await import('./keyboard/macos-keyboard-input-source')
      const stdout = await readKeyboardInputSourceId()
      const trimmed = stdout?.trim() ?? ''
      return trimmed.length > 0 ? trimmed : null
    } catch {
      // A failed probe must not promote an IME's backing layout into an Alt default.
      return null
    }
  })

  ipcMain.handle('app:getKeyboardLayoutSnapshot', async () => {
    const { readMacKeyboardLayoutSnapshot } =
      await import('./keyboard/macos-keyboard-layout-snapshot')
    return readMacKeyboardLayoutSnapshot()
  })

  ipcMain.handle('app:setWindowMaterialSuppressed', (event, suppressed: unknown) => {
    const window = isTrustedUIRenderer(event.sender)
      ? BrowserWindow.fromWebContents(event.sender)
      : null
    if (window && typeof suppressed === 'boolean') {
      setWindowMaterialSuppressed(window, suppressed)
    }
  })

  ipcMain.handle('app:relaunch', async () => {
    // Delay teardown so the renderer can paint Restarting after cleanup.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    await announceRuntimeRelaunch()
    await runBeforeRelaunchCleanup(options.onBeforeRelaunchExit)
    setTimeout(() => {
      // app.exit skips before-quit; remove the Windows tray to avoid a stale icon.
      destroySystemTray()
      relaunchApp('renderer-request')
      app.exit(0)
    }, 150)
  })

  ipcMain.handle('app:quit', (event) => handleAppQuitRequest(event, () => options.onQuit?.()))

  ipcMain.handle('app:restart', async () => {
    // Normal quit flushes daemon checkpoints and telemetry.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    await announceRuntimeRelaunch()
    setTimeout(() => {
      relaunchApp('admin-restart')
      quitProcess()
    }, 150)
  })

  ipcMain.handle('app:restartAsAdministrator', async () => {
    const { prepareWindowsAdministratorRestart } =
      await import('../windows/windows-administrator-restart')
    const relaunchOptions = prepareWindowsAdministratorRestart()
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    await announceRuntimeRelaunch()
    setTimeout(() => {
      relaunchApp('windows-administrator', undefined, relaunchOptions)
      quitProcess()
    }, 150)
  })

  registerMacSymbolicHotkeysProbeHandler(readCommandStdout)

  ipcMain.handle(
    'app:getFloatingTerminalCwd',
    async (_event, args?: FloatingTerminalCwdRequest) => {
      const { resolveFloatingTerminalCwd } =
        await import('./worktrees/floating-workspace-directory')
      return resolveFloatingTerminalCwd(store, args)
    }
  )

  ipcMain.handle('app:getFloatingMarkdownDirectory', async () => {
    const { ensureDefaultFloatingWorkspacePath } =
      await import('./worktrees/floating-workspace-directory')
    return ensureDefaultFloatingWorkspacePath()
  })

  ipcMain.handle('app:pickFloatingMarkdownDocument', (event) => pickFloatingMarkdownDocument(event))

  ipcMain.handle('app:pickFloatingWorkspaceDirectory', (event) =>
    pickFloatingWorkspaceDirectory(event, store)
  )
}
