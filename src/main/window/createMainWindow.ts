import { BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import devIcon from '../../../resources/icon-dev.png?asset'
import type { Store } from '../persistence'
import { browserManager } from '../browser/browser-manager'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import { resolveWindowShortcutAction } from '../../shared/window-shortcut-policy'

function forceRepaint(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }
  window.webContents.invalidate()
  if (window.isMaximized() || window.isFullScreen()) {
    return
  }
  const [width, height] = window.getSize()
  window.setSize(width + 1, height)
  setTimeout(() => {
    if (!window.isDestroyed()) {
      window.setSize(width, height)
    }
  }, 32)
}

// Why: the titlebar is 42px (border-box, 1px border-bottom).  The visual
// center of the CSS-centered content sits at ~20 CSS px from the top.
// At zoom factor z that becomes 20·z window px.  Traffic lights are
// ~12px tall, so we position their top edge at (center − 6).
const TITLEBAR_CSS_CENTER = 20
const TRAFFIC_LIGHT_RADIUS = 6
const TRAFFIC_LIGHT_X = 16

function syncTrafficLightPosition(win: BrowserWindow, zoomFactor: number): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) {
    return
  }
  const y = Math.round(TITLEBAR_CSS_CENTER * zoomFactor - TRAFFIC_LIGHT_RADIUS)
  win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y })
}

type CreateMainWindowOptions = {
  /** Returns true when a manual app.quit() (Cmd+Q) is in progress. The close
   *  handler sends this to the renderer so it can skip the running-process
   *  confirmation dialog and proceed directly to buffer capture + close. */
  getIsQuitting?: () => boolean
  /** Notifies the caller when the renderer vetoes unload. Why: a prevented
   *  beforeunload cancels the in-flight app.quit(), so the app-level quit
   *  latch must be cleared or later window closes will be misclassified as
   *  quit attempts. */
  onQuitAborted?: () => void
}

export function createMainWindow(
  store: Store | null,
  opts?: CreateMainWindowOptions
): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    // Why: initial position for 1x zoom; syncTrafficLightPosition() adjusts
    // dynamically when the user changes UI zoom.
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: {
            x: TRAFFIC_LIGHT_X,
            y: TITLEBAR_CSS_CENTER - TRAFFIC_LIGHT_RADIUS
          }
        }
      : {}),
    icon: is.dev ? devIcon : icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: true
    }
  })

  if (process.platform === 'darwin') {
    // Why: persistent parked webviews use separate compositor layers, and on
    // recent macOS releases those layers can fail to repaint after occlusion or
    // restore. Disabling main-window throttling and forcing a repaint on
    // visibility transitions hardens Orca against the same black-surface
    // failure mode seen during browser-tab restore and tab switching.
    mainWindow.webContents.setBackgroundThrottling(false)
    mainWindow.on('restore', () => {
      forceRepaint(mainWindow)
    })
    mainWindow.on('show', () => {
      forceRepaint(mainWindow)
    })
  }

  mainWindow.webContents.on('dom-ready', () => {
    const level = store?.getUI().uiZoomLevel ?? 0
    mainWindow.webContents.setZoomLevel(level)
    // Why: the native traffic lights sit at a fixed position in the window
    // while CSS content scales with zoom.  We must reposition the buttons
    // on startup so they stay vertically aligned with the zoomed titlebar.
    if (process.platform === 'darwin') {
      syncTrafficLightPosition(mainWindow, Math.pow(1.2, level))
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const externalUrl = normalizeExternalBrowserUrl(details.url)
    if (externalUrl) {
      shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''

    // Why: arbitrary sites must stay inside an unprivileged guest surface. We
    // fail closed here so a renderer bug cannot smuggle preload, Node, or a
    // non-browser partition into the guest and widen the app privilege boundary.
    // The one allowed data URL is Orca's inert blank-tab bootstrap page; deny
    // every other data URL so the renderer cannot inject arbitrary inline HTML.
    if (!normalizedSrc || partition !== ORCA_BROWSER_PARTITION) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    // Why: older Electron builds expose preloadURL alongside preload; delete
    // both so the guest surface cannot inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.partition = ORCA_BROWSER_PARTITION
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    // Why: popup and navigation policy must attach as soon as Chromium creates
    // the guest webContents. Waiting until renderer-driven registration leaves
    // a race where target=_blank or early redirects can bypass Orca's intended
    // fallback behavior.
    browserManager.attachGuestPolicies(guest)
  })

  // Block ALL in-window navigations to prevent remote pages from inheriting
  // the privileged preload bridge (PTY, filesystem, etc.).
  // In dev mode, allow navigations to the local dev server (e.g. HMR reloads).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalBrowserUrl(url)

    if (externalUrl) {
      const target = new URL(externalUrl)
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        try {
          const allowed = new URL(process.env.ELECTRON_RENDERER_URL)
          if (target.origin === allowed.origin) {
            return // allow dev server navigations (HMR, etc.)
          }
        } catch {
          // fall through to prevent
        }
      }

      shell.openExternal(externalUrl)
    }

    event.preventDefault()
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    if (is.dev && input.code === 'F12') {
      event.preventDefault()
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
      return
    }

    // Why: keep the main-process interception surface as an explicit allowlist.
    // Anything outside this helper must continue to the renderer/PTTY so
    // readline control chords are not silently stolen above the terminal.
    const action = resolveWindowShortcutAction(input, process.platform)
    if (!action) {
      return
    }

    event.preventDefault()

    if (action.type === 'zoom') {
      mainWindow.webContents.send('terminal:zoom', action.direction)
      return
    }

    if (action.type === 'toggleWorktreePalette') {
      // Why: embedded browser guests can keep keyboard focus inside Chromium's
      // guest webContents, which bypasses the renderer's window-level keydown
      // listener. Forward the worktree-switch shortcut through the main window
      // so Cmd+J (macOS) or Ctrl+Shift+J (Win/Linux) works consistently from browser tabs too.
      mainWindow.webContents.send('ui:toggleWorktreePalette')
      return
    }

    if (action.type === 'openQuickOpen') {
      // Forward Cmd/Ctrl+P to trigger Quick Open
      mainWindow.webContents.send('ui:openQuickOpen')
      return
    }

    if (action.type === 'jumpToWorktreeIndex') {
      // Forward Cmd/Ctrl+1-9 for quick worktree switching
      mainWindow.webContents.send('ui:jumpToWorktreeIndex', action.index)
    }
  })

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Why: Some keyboard layouts/platforms consume Ctrl/Cmd+Minus before
    // before-input-event fires, but still emit Electron's zoom command. We
    // reroute that command to terminal zoom so zoom-out remains reachable.
    event.preventDefault()
    if (zoomDirection === 'in') {
      mainWindow.webContents.send('terminal:zoom', 'in')
    } else if (zoomDirection === 'out') {
      mainWindow.webContents.send('terminal:zoom', 'out')
    }
  })

  // Intercept window close so the renderer can show a confirmation dialog
  // when terminals with running processes would be killed. The renderer
  // replies with 'window:confirm-close' to proceed, or does nothing to cancel.
  let windowCloseConfirmed = false
  const confirmCloseChannel = 'window:confirm-close'

  mainWindow.on('close', (e) => {
    if (windowCloseConfirmed) {
      windowCloseConfirmed = false
      return
    }
    e.preventDefault()
    mainWindow.webContents.send('window:close-requested', {
      isQuitting: opts?.getIsQuitting?.() ?? false
    })
  })
  mainWindow.webContents.on('will-prevent-unload', () => {
    opts?.onQuitAborted?.()
  })

  const onConfirmClose = (): void => {
    windowCloseConfirmed = true
    if (!mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  }
  const trafficLightChannel = 'ui:sync-traffic-lights'
  const onSyncTrafficLights = (_event: Electron.IpcMainEvent, zoomFactor: number): void => {
    syncTrafficLightPosition(mainWindow, zoomFactor)
  }
  ipcMain.on(trafficLightChannel, onSyncTrafficLights)

  ipcMain.on(confirmCloseChannel, onConfirmClose)
  mainWindow.on('closed', () => {
    ipcMain.removeListener(trafficLightChannel, onSyncTrafficLights)
    ipcMain.removeListener(confirmCloseChannel, onConfirmClose)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
