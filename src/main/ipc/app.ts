import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import type { FloatingTerminalCwdRequest } from '../../shared/types'
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

export function registerAppHandlers(): void {
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
