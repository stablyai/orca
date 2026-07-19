import {
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  screen,
  type Display,
  type Rectangle
} from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  computeStatusPillPlacement,
  getCursorScreenPointSafe,
  pickDisplayForCursor
} from './placement'
import { StatusPillBroadcaster, type StatusPillBroadcasterOptions } from './status-pill-broadcaster'
import { computeStatusPillAgentRows, computeStatusPillSummary } from './status-pill-summary'
import type {
  StatusPillAgentRow,
  StatusPillPreferences,
  StatusPillSummary
} from '../../../shared/status-pill-preload-api'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

/** Pill body dimensions in CSS pixels. Wide enough for "claude — fix-auth-bug ·
 *  Writing middleware.ts"; tall enough that hover and click targets stay
 *  comfortable on a 4K display at 100% scaling. */
const PILL_WIDTH = 320
const PILL_HEIGHT = 32

export type CreateStatusPillWindowOptions = {
  /** Pulls the current full agent-status snapshot. Used by the broadcaster
   *  and the initial pull channel. */
  getSnapshot: () => AgentStatusIpcPayload[]
  /** Focus the Orca main window (reopening it if needed). Called when the user
   *  clicks the pill body. */
  onFocusMainWindow: () => void
  /** Optional logger; defaults to console.warn. */
  warn?: (message: string, error?: unknown) => void
  /** Scheduler overrides for tests. */
  broadcasterOptions?: Pick<StatusPillBroadcasterOptions, 'now' | 'scheduler' | 'clearScheduler'>
}

export type StatusPillWindowHandle = {
  /** The underlying BrowserWindow. Caller must guard with `isDestroyed()`. */
  window: BrowserWindow
  /** Re-anchor the pill on display-metrics / display-added / display-removed. */
  refreshPlacement: () => void
  /** Push a new summary to the pill renderer (coalesced by the broadcaster). */
  broadcastSnapshot: () => void
  /** Tear down the window and its broadcaster. Idempotent. */
  destroy: () => void
}

export function createStatusPillWindow(
  options: CreateStatusPillWindowOptions
): StatusPillWindowHandle | null {
  const warn = options.warn ?? defaultWarn
  const getEntries = (): AgentStatusIpcPayload[] => options.getSnapshot()
  const getSummary = (): StatusPillSummary => computeStatusPillSummary(getEntries())
  const getRows = (): StatusPillAgentRow[] => computeStatusPillAgentRows(getEntries())

  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      // Why: transparent keeps the pill visually floating on all platforms.
      // Some Linux Wayland compositors lack alpha support; we recover at
      // runtime via the backgroundColor round-trip below.
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      // Why: macOS-specific keys keep the pill out of Mission Control and the
      // app switcher, and let the renderer draw its own capsule shape.
      hiddenInMissionControl: process.platform === 'darwin',
      roundedCorners: false,
      // Why: 'panel' on macOS floats above full-screen apps without activating
      // the app; on Linux/Windows the value is undefined so they fall back to
      // a normal top-level window.
      type: process.platform === 'darwin' ? 'panel' : undefined,
      show: false,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/status-pill.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  } catch (error) {
    warn('[status-pill] failed to create BrowserWindow', error)
    return null
  }

  // Why: setVisibleOnAllWorkspaces is the cross-version-safe way to anchor
  // the pill on every macOS Space and Linux workspace. The constructor option
  // form is typed inconsistently across Electron minors.
  try {
    window.setVisibleOnAllWorkspaces(true, {
      // Why: skipTransformAccessibility on macOS, visibleOnFullScreen where
      // supported. Falling back gracefully on Linux Wayland where the flag is
      // only a hint.
      skipTransformProcessType: true
    })
  } catch {
    // Best-effort; some platforms reject the options bag.
    try {
      window.setVisibleOnAllWorkspaces(true)
    } catch {
      // Headless / test environment.
    }
  }

  // Why: try to confirm the transparent background actually took; if the
  // compositor rejected it the renderer will draw an opaque capsule fallback.
  try {
    window.setBackgroundColor('#00000000')
  } catch {
    // Best-effort; some Linux compositors reject this and Electron throws.
  }

  // Why: 'screen-saver' level on Windows is the only one that clears the
  // taskbar z-order. 'floating' (the default) leaves the pill under the
  // taskbar on Win10/11.
  if (process.platform === 'win32') {
    try {
      window.setAlwaysOnTop(true, 'screen-saver')
    } catch {
      // Older Electron versions may not accept the level argument.
    }
  }

  const initialPlacement = computePlacementForActiveDisplay(warn)
  if (initialPlacement) {
    try {
      window.setBounds(initialPlacement, false)
    } catch (error) {
      warn('[status-pill] failed to set initial bounds', error)
    }
  }

  const broadcaster = new StatusPillBroadcaster({
    getSnapshot: options.getSnapshot,
    send: (payload) => {
      if (window.isDestroyed()) {
        return
      }
      try {
        // Why: push summary + rows together so the renderer's resting pill
        // and its expanded panel never disagree, even though only the resting
        // pill paints by default.
        window.webContents.send('statusPill:snapshot', payload.summary)
        window.webContents.send('statusPill:agentRows', payload.rows)
      } catch {
        // Swallow: webContents mid-teardown.
      }
    },
    ...options.broadcasterOptions
  })

  const detachDisplayListeners = attachDisplayListeners(refreshPlacement)
  const detachIpc = attachIpcListeners({
    window,
    onFocusMainWindow: options.onFocusMainWindow,
    getSummary,
    getRows
  })

  // Why: push the initial snapshot as soon as the renderer signals it is
  // ready, so the pill never paints an empty state for 250 ms on first mount.
  window.once('ready-to-show', () => {
    try {
      broadcaster.flushNow()
      // Why: showInactive so the pill never steals focus from the editor or
      // the Orca main window when it appears.
      window.showInactive()
    } catch (error) {
      warn('[status-pill] failed initial show', error)
    }
  })

  // Why: load the dedicated pill entry. Dev uses the electron-vite URL; prod
  // uses the packaged HTML file.
  loadPillEntry(window, warn).catch((error) => {
    warn('[status-pill] failed to load pill entry', error)
  })

  function refreshPlacement(): void {
    if (window.isDestroyed()) {
      return
    }
    const next = computePlacementForActiveDisplay(warn)
    if (!next) {
      return
    }
    try {
      window.setBounds(next, false)
    } catch (error) {
      warn('[status-pill] failed to apply refreshed bounds', error)
    }
  }

  function destroy(): void {
    detachDisplayListeners()
    detachIpc()
    broadcaster.destroy()
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  return {
    window,
    refreshPlacement,
    broadcastSnapshot: () => broadcaster.scheduleBroadcast(),
    destroy
  }

  function computePlacementForActiveDisplay(
    warnFn: (m: string, e?: unknown) => void
  ): Rectangle | null {
    let displays: Display[] = []
    try {
      displays = screen.getAllDisplays()
    } catch (error) {
      warnFn('[status-pill] screen.getAllDisplays failed', error)
      return null
    }
    if (displays.length === 0) {
      return null
    }
    const cursor = getCursorScreenPointSafe(screen)
    const display = pickDisplayForCursor(displays, cursor)
    if (!display) {
      return null
    }
    return computeStatusPillPlacement({
      pillWidth: PILL_WIDTH,
      pillHeight: PILL_HEIGHT,
      display,
      platform: process.platform
    })
  }
}

async function loadPillEntry(
  window: BrowserWindow,
  warn: (m: string, e?: unknown) => void
): Promise<void> {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/status-pill/`)
    return
  }
  try {
    await window.loadFile(join(__dirname, '../renderer/status-pill/index.html'))
  } catch (error) {
    warn('[status-pill] loadFile failed; retrying once after build flush', error)
    // Why: a freshly rebuilt dev package can race the renderer file flush.
    // Retry once after a short tick before giving up.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await window.loadFile(join(__dirname, '../renderer/status-pill/index.html'))
  }
}

type IpcListenerArgs = {
  window: BrowserWindow
  onFocusMainWindow: () => void
  getSummary: () => StatusPillSummary
  getRows: () => StatusPillAgentRow[]
}

function attachIpcListeners(args: IpcListenerArgs): () => void {
  const clickHandler = (): void => {
    args.onFocusMainWindow()
  }
  const contextMenuHandler = (): void => {
    // Why: V1 ships a minimal context menu; rich options (Pin to display,
    // Settings) land in a follow-up alongside the tray checkbox.
    try {
      const menu = Menu.buildFromTemplate([
        { label: 'Orca status pill', enabled: false },
        { type: 'separator' },
        {
          label: 'Hide pill',
          click: () => {
            // Why: send a self-message so the renderer can animate out before
            // the window is destroyed by the settings change.
            try {
              args.window.webContents.send('statusPill:requestHide')
            } catch {
              // Best-effort.
            }
          }
        }
      ])
      menu.popup()
    } catch {
      // Best-effort; right-click never blocks the pill.
    }
  }
  const snapshotHandler = (): StatusPillSummary => args.getSummary()
  const rowsHandler = (): StatusPillAgentRow[] => args.getRows()
  const prefsHandler = (): StatusPillPreferences => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    // Why: main process cannot read the renderer's matchMedia. The pill
    // renderer queries prefers-reduced-motion itself on mount and merges with
    // this preference snapshot.
    prefersReducedMotion: false
  })

  ipcMain.on('statusPill:click', clickHandler)
  ipcMain.on('statusPill:contextMenu', contextMenuHandler)
  ipcMain.handle('statusPill:getSnapshot', snapshotHandler)
  ipcMain.handle('statusPill:getAgentRows', rowsHandler)
  ipcMain.handle('statusPill:getInitialPreferences', prefsHandler)

  return () => {
    ipcMain.removeListener('statusPill:click', clickHandler)
    ipcMain.removeListener('statusPill:contextMenu', contextMenuHandler)
    ipcMain.removeHandler('statusPill:getSnapshot')
    ipcMain.removeHandler('statusPill:getAgentRows')
    ipcMain.removeHandler('statusPill:getInitialPreferences')
  }
}

function attachDisplayListeners(refresh: () => void): () => void {
  const onMetrics = (): void => refresh()
  const onAdded = (): void => refresh()
  const onRemoved = (): void => refresh()
  try {
    screen.on('display-metrics-changed', onMetrics)
    screen.on('display-added', onAdded)
    screen.on('display-removed', onRemoved)
  } catch {
    // Best-effort; headless/test environments may not emit these.
  }
  return () => {
    try {
      screen.off('display-metrics-changed', onMetrics)
      screen.off('display-added', onAdded)
      screen.off('display-removed', onRemoved)
    } catch {
      // Best-effort.
    }
  }
}

function defaultWarn(message: string, error?: unknown): void {
  // Why: keep the signature console-style so callers can substitute
  // `(m, e) => console.warn(m, e)` in tests without adapter gymnastics.
  if (error === undefined) {
    console.warn(message)
  } else {
    console.warn(message, error)
  }
}

// Re-exported so the main index can keep a single import line for the
// status-pill subsystem.
export { StatusPillBroadcaster }
export type { StatusPillAgentRow, StatusPillPreferences, StatusPillSummary }
