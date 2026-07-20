import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AppIdentity } from '../../shared/app-identity'
import type { FloatingTerminalCwdRequest, MarkdownDocument } from '../../shared/types'
import { relaunchApp } from '../app-relaunch'
import type { Store } from '../persistence'
import { getDevInstanceIdentity } from '../startup/dev-instance-identity'
import { isPwshAvailable } from '../pwsh'
import { isWslAvailable, listWslDistros } from '../wsl'
import { isGitBashAvailable } from '../git-bash'
import { setUnreadDockBadgeCount } from '../dock/unread-badge'
import { destroySystemTray } from '../tray/system-tray'
import { authorizeExternalPath } from './filesystem-auth'
import {
  ensureDefaultFloatingWorkspacePath,
  grantFloatingWorkspaceDirectory,
  resolveFloatingTerminalCwd
} from './floating-workspace-directory'
import { isMarkdownDocumentName, markdownDocumentFromFilePath } from './markdown-documents'
import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'

const KEYBOARD_INPUT_SOURCE_TIMEOUT_MS = 500
const MAC_HITOOLBOX_DOMAIN = 'com.apple.HIToolbox'
// Why: macOS 15's `plutil -extract <key> json` aborts on the (pure-string)
// input-source array and the on-disk plist lags cfprefsd; read live prefs via
// `defaults export`, extract as xml1 (dodges the json bug), then convert to JSON.
// Absolute paths so a GUI-launched app's minimal PATH can't shadow the tools.
const MAC_SELECTED_INPUT_SOURCES_JSON_COMMAND = [
  `/usr/bin/defaults export ${MAC_HITOOLBOX_DOMAIN} -`,
  '/usr/bin/plutil -extract AppleSelectedInputSources xml1 -o - -',
  '/usr/bin/plutil -convert json -o - -'
].join(' | ')

type RegisterAppHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
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
    // Why: this picker grants access to an existing workspace directory.
    // Creation belongs to explicit file/write actions, not typeahead input.
    properties: ['openDirectory']
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

function readCommandStdout(
  command: string,
  args: string[],
  timeoutMessage: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof spawn> | undefined

    // Why: the probe runs a `/bin/sh -c` pipeline, so signaling only the shell
    // orphans wedged `defaults`/`plutil` stages on a stuck cfprefsd. Spawning
    // detached makes the child a process-group leader, so one negative-pid
    // SIGKILL reaps the shell and every stage; child.kill() covers the fallback.
    const killTree = (): void => {
      if (!child?.pid) {
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill()
      }
    }

    // Why: short timeout so a wedged macOS preference probe (corporate-managed
    // config, sandbox policy, ...) never holds the handle indefinitely. This
    // manual timer is the only timeout guard, so it owns the process-group kill.
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      killTree()
      reject(new Error(timeoutMessage))
    }, KEYBOARD_INPUT_SOURCE_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      const failWith = (error: Error): void => {
        killTree()
        settle(() => reject(error))
      }
      // Why: an unhandled Readable 'error' would crash the main process; treat a
      // stdout read failure the same as a child spawn error.
      child.stdout?.on('error', failWith)
      child.on('error', failWith)
      child.on('close', (code, signal) => {
        settle(() =>
          code === 0
            ? resolve(stdout)
            : reject(
                new Error(
                  `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
                )
              )
        )
      })
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

function readSelectedInputSourceIdFromJson(stdout: string): string | null {
  let records: unknown
  try {
    records = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(records)) {
    return null
  }

  for (const record of records.slice().toReversed()) {
    if (!record || typeof record !== 'object') {
      continue
    }
    const fields = record as Record<string, unknown>
    const kind = typeof fields.InputSourceKind === 'string' ? fields.InputSourceKind : ''
    if (kind.toLowerCase().includes('non keyboard')) {
      continue
    }
    const inputMode = fields['Input Mode']
    if (typeof inputMode === 'string' && inputMode.trim()) {
      return inputMode.trim()
    }
    const bundleId = fields['Bundle ID']
    if (typeof bundleId === 'string' && bundleId.trim()) {
      return bundleId.trim()
    }
  }
  return null
}

async function readSelectedKeyboardInputSourceId(): Promise<string | null> {
  try {
    const stdout = await readCommandStdout(
      '/bin/sh',
      ['-c', MAC_SELECTED_INPUT_SOURCES_JSON_COMMAND],
      'Selected keyboard input source probe timed out'
    )
    return readSelectedInputSourceIdFromJson(stdout)
  } catch {
    return null
  }
}

function readKeyboardLayoutInputSourceId(): Promise<string> {
  return readCommandStdout(
    '/usr/bin/defaults',
    ['read', MAC_HITOOLBOX_DOMAIN, 'AppleCurrentKeyboardLayoutInputSourceID'],
    'Keyboard layout input source probe timed out'
  )
}

async function readKeyboardInputSourceId(): Promise<string | null> {
  const selectedInputSourceId = await readSelectedKeyboardInputSourceId()
  if (selectedInputSourceId) {
    return selectedInputSourceId
  }
  return readKeyboardLayoutInputSourceId()
}

export function registerAppHandlers(store: Store, options: RegisterAppHandlersOptions = {}): void {
  registerRendererShutdownCheckpointHandler(store)

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
  ipcMain.handle('gitBash:isAvailable', (): boolean => isGitBashAvailable())

  // Why: ABC, Polish Pro, US Extended, ABC Extended, and every CJK Roman
  // IME all report a US-QWERTY base layer to navigator.keyboard.getLayoutMap()
  // — the layout-fingerprint probe in the renderer therefore classifies
  // them as 'us' and flips macOptionIsMeta=true, silently swallowing every
  // Option+letter composition (#1205: Option+A → å / ą is dropped). The
  // macOS-shipped `com.apple.HIToolbox` preferences name the actual input
  // mode when one is selected, falling back to the keyboard layout ID
  // (e.g. `com.apple.keylayout.ABC` vs `com.apple.keylayout.US`), which
  // the renderer uses as an authoritative override. Non-Darwin platforms
  // have no equivalent and return null so the fingerprint stays the only
  // signal.
  ipcMain.handle('app:getKeyboardInputSourceId', async (): Promise<string | null> => {
    if (process.platform !== 'darwin') {
      return null
    }
    try {
      // Why: async so the probe never blocks the main-process event loop.
      // The probe re-runs on every window focus-in (see option-as-alt-probe.ts),
      // and a blocking execFileSync would briefly stall unrelated IPC each
      // time the user Alt-Tabbed back into the app.
      const stdout = await readKeyboardInputSourceId()
      const trimmed = stdout?.trim() ?? ''
      return trimmed.length > 0 ? trimmed : null
    } catch {
      // Why: macOS preference probes can fail when keys are absent (first boot
      // before any input-source interaction), or when sandboxed. Treat that as
      // "no signal" — the fingerprint still runs as fallback.
      return null
    }
  })

  ipcMain.handle('app:relaunch', async () => {
    // Why: small delay lets the renderer finish painting any "Restarting…"
    // UI state before the window tears down. `app.relaunch()` schedules a
    // spawn; `app.exit(0)` triggers the actual quit without invoking
    // before-quit handlers that could block on confirmation dialogs.
    // Mark shutdown first because app.exit() can bypass the usual quit latch.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    setTimeout(() => {
      // Why: app.exit(0) skips before-quit/will-quit, so clean the Windows tray
      // explicitly before relaunching to avoid a stale notification-area icon.
      destroySystemTray()
      relaunchApp('renderer-request')
      app.exit(0)
    }, 150)
  })

  ipcMain.handle('app:restart', async () => {
    // Why: the hidden admin restart should mirror the update relaunch path:
    // schedule a new Orca process, then use the normal quit pipeline so daemon
    // checkpoints, runtime metadata, and telemetry flush before exit.
    await runBeforeRelaunchCleanup(options.onBeforeRelaunch)
    setTimeout(() => {
      relaunchApp('admin-restart')
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

async function runBeforeRelaunchCleanup(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    // Why: restart/relaunch must not get trapped if best-effort shutdown
    // cleanup fails; the cleanup path logs without exposing secret contents.
    console.warn(
      '[app] Pre-relaunch cleanup failed; continuing relaunch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}
