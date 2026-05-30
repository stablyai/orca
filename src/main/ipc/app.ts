import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AppIdentity } from '../../shared/app-identity'
import type { FloatingTerminalCwdRequest, MarkdownDocument } from '../../shared/types'
import type { Store } from '../persistence'
import { getDevInstanceIdentity } from '../startup/dev-instance-identity'
import { isPwshAvailable } from '../pwsh'
import { isWslAvailable, listWslDistros } from '../wsl'
import { setUnreadDockBadgeCount } from '../dock/unread-badge'
import { authorizeExternalPath } from './filesystem-auth'
import {
  ensureDefaultFloatingWorkspacePath,
  grantFloatingWorkspaceDirectory,
  resolveFloatingTerminalCwd
} from './floating-workspace-directory'
import { isMarkdownDocumentName, markdownDocumentFromFilePath } from './markdown-documents'

const execFileAsync = promisify(execFile)

type RegisterAppHandlersOptions = {
  onBeforeRelaunch?: () => void
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
  authorizeExternalPath(filePath)
  return markdownDocumentFromFilePath(cwd, filePath, { outsideRootRelativePath: 'basename' })
}

async function pickFloatingWorkspaceDirectory(
  event: IpcMainInvokeEvent,
  store: Store
): Promise<string | null> {
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  const options = {
    properties: ['openDirectory', 'createDirectory']
  } satisfies Electron.OpenDialogOptions
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const selectedDir = result.filePaths[0]
  // Why: a user-approved picker selection is a trust grant for later Floating
  // Workspace markdown creation, unlike arbitrary typed settings text.
  await grantFloatingWorkspaceDirectory(store, selectedDir)
  return selectedDir
}

function getFeatureWallAssetBaseUrl(): string {
  const assetDir = app.isPackaged
    ? path.join(process.resourcesPath, 'onboarding', 'feature-wall')
    : resolveDevFeatureWallAssetDir()

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const vitePath = assetDir.split(path.sep).join('/')
    const absoluteVitePath = vitePath.startsWith('/') ? vitePath : `/${vitePath}`
    // Why: the dev renderer is served from http://localhost, where Chromium
    // blocks file:// image loads. Vite's /@fs route serves the same local media.
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

  // Why: E2E launches out/main/index.js, so app.getAppPath() can point at
  // out/main even though development resources still live at the repo root.
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function registerAppHandlers(store: Store, options: RegisterAppHandlersOptions = {}): void {
  ipcMain.handle('app:getFeatureWallAssetBaseUrl', (): string => getFeatureWallAssetBaseUrl())

  ipcMain.handle('app:getIdentity', (): AppIdentity => {
    const identity = getDevInstanceIdentity(is.dev)
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

  ipcMain.handle('wsl:isAvailable', (): boolean => isWslAvailable())
  ipcMain.handle('wsl:listDistros', (): string[] => listWslDistros())
  ipcMain.handle('pwsh:isAvailable', (): boolean => isPwshAvailable())

  // Why: ABC, Polish Pro, US Extended, ABC Extended, and every CJK Roman
  // IME all report a US-QWERTY base layer to navigator.keyboard.getLayoutMap()
  // — the layout-fingerprint probe in the renderer therefore classifies
  // them as 'us' and flips macOptionIsMeta=true, silently swallowing every
  // Option+letter composition (#1205: Option+A → å / ą is dropped). The
  // macOS-shipped `com.apple.HIToolbox` preference
  // `AppleCurrentKeyboardLayoutInputSourceID` names the actual layout
  // (e.g. `com.apple.keylayout.ABC` vs `com.apple.keylayout.US`), which
  // the renderer uses as an authoritative override. Non-Darwin platforms
  // have no equivalent and return null so the fingerprint stays the only
  // signal.
  //
  // Why `defaults read` (via execFileSync) and not systemPreferences
  // .getUserDefault: getUserDefault only reads from NSGlobalDomain and the
  // current app's own domain. The keyboard layout ID lives in the
  // `com.apple.HIToolbox` domain, which getUserDefault cannot reach —
  // observed to return null even when the preference is set. The `defaults`
  // CLI reads any domain and is the same mechanism Apple documents for
  // this value.
  ipcMain.handle('app:getKeyboardInputSourceId', async (): Promise<string | null> => {
    if (process.platform !== 'darwin') {
      return null
    }
    try {
      // Why: async so the probe never blocks the main-process event loop.
      // The probe re-runs on every window focus-in (see option-as-alt-probe.ts),
      // and a blocking execFileSync would briefly stall unrelated IPC each
      // time the user Alt-Tabbed back into the app.
      const { stdout } = await execFileAsync(
        '/usr/bin/defaults',
        ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
        // Why: short timeout so a wedged defaults binary (corporate-managed
        // config, sandbox policy, …) never holds the handle indefinitely.
        // Fall through to the fingerprint on timeout.
        { encoding: 'utf8', timeout: 500 }
      )
      const trimmed = stdout.trim()
      return trimmed.length > 0 ? trimmed : null
    } catch {
      // Why: defaults exits non-zero when the key is absent (first boot
      // before any input-source interaction), or when sandboxed. Treat
      // that as "no signal" — the fingerprint still runs as fallback.
      return null
    }
  })

  ipcMain.handle('app:relaunch', () => {
    // Why: small delay lets the renderer finish painting any "Restarting…"
    // UI state before the window tears down. `app.relaunch()` schedules a
    // spawn; `app.exit(0)` triggers the actual quit without invoking
    // before-quit handlers that could block on confirmation dialogs.
    // Mark shutdown first because app.exit() can bypass the usual quit latch.
    options.onBeforeRelaunch?.()
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
  })

  ipcMain.handle('app:restart', () => {
    // Why: the hidden admin restart should mirror the update relaunch path:
    // schedule a new Orca process, then use the normal quit pipeline so daemon
    // checkpoints, runtime metadata, and telemetry flush before exit.
    options.onBeforeRelaunch?.()
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 150)
  })

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
