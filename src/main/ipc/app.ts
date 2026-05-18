import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AppIdentity } from '../../shared/app-identity'
import type { FloatingTerminalCwdRequest } from '../../shared/types'
import { getDevInstanceIdentity } from '../startup/dev-instance-identity'
import { isPwshAvailable } from '../pwsh'
import { isWslAvailable } from '../wsl'
import { setUnreadDockBadgeCount } from '../dock/unread-badge'

const execFileAsync = promisify(execFile)

function expandHomePath(input: string, home: string): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(home, input.slice(2))
  }
  if (process.platform === 'win32' && input.startsWith('~/')) {
    return path.join(home, input.slice(2))
  }
  return input
}

async function resolveFloatingTerminalCwd(args?: FloatingTerminalCwdRequest): Promise<string> {
  const home = app.getPath('home')
  const configuredPath = args?.path?.trim()
  if (!configuredPath) {
    return home
  }
  const expanded = expandHomePath(configuredPath, home)
  const cwd = path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded)
  try {
    await mkdir(cwd, { recursive: true })
    return cwd
  } catch {
    return home
  }
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

export function registerAppHandlers(): void {
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
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
  })

  ipcMain.handle('app:setUnreadDockBadgeCount', (_event, count: number) => {
    setUnreadDockBadgeCount(Number.isFinite(count) ? count : 0)
  })

  ipcMain.handle('app:getFloatingTerminalCwd', (_event, args?: FloatingTerminalCwdRequest) =>
    resolveFloatingTerminalCwd(args)
  )
}
