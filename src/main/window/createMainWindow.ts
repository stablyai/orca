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

function isZoomInShortcut(input: Electron.Input): boolean {
  return input.key === '=' || input.key === '+' || input.code === 'NumpadAdd'
}

function isZoomOutShortcut(input: Electron.Input): boolean {
  // Why: Electron reports Cmd/Ctrl+Minus differently across layouts and devices:
  // some emit '-' while shifted layouts emit '_', and other layouts/devices
  // report symbolic names like "Minus"/"Subtract" in either key or code.
  // We accept all known variants so zoom out remains reachable everywhere.
  const key = (input.key ?? '').toLowerCase()
  const code = (input.code ?? '').toLowerCase()
  return (
    key === '-' ||
    key === '_' ||
    key.includes('minus') ||
    key.includes('subtract') ||
    code.includes('minus') ||
    code.includes('subtract')
  )
}

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

export function createMainWindow(store: Store | null): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 12 } } : {}),
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
    mainWindow.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
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

    const modifierPressed = process.platform === 'darwin' ? input.meta : input.control
    if (!modifierPressed || input.alt) {
      return
    }

    if (isZoomInShortcut(input)) {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'in')
    } else if (isZoomOutShortcut(input)) {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'out')
    } else if (input.key === '0' && !input.shift) {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'reset')
    } else if (
      input.code === 'KeyJ' &&
      ((process.platform === 'darwin' && !input.shift) ||
        (process.platform !== 'darwin' && input.shift))
    ) {
      // Why: embedded browser guests can keep keyboard focus inside Chromium's
      // guest webContents, which bypasses the renderer's window-level keydown
      // listener. Forward the worktree-switch shortcut through the main window
      // so Cmd+J (macOS) or Ctrl+Shift+J (Win/Linux) works consistently from browser tabs too.
      // We use Ctrl+Shift+J on Win/Linux because Ctrl+J is the ASCII Line Feed control code
      // and intercepting it would break standard terminal usage (like Enter in shells or Vim).
      event.preventDefault()
      mainWindow.webContents.send('ui:toggleWorktreePalette')
    } else if (input.code === 'KeyP' && !input.shift) {
      // Forward Cmd/Ctrl+P to trigger Quick Open
      event.preventDefault()
      mainWindow.webContents.send('ui:openQuickOpen')
    } else if (input.key >= '1' && input.key <= '9' && !input.shift) {
      // Forward Cmd/Ctrl+1-9 for quick worktree switching
      event.preventDefault()
      const index = parseInt(input.key, 10) - 1
      mainWindow.webContents.send('ui:jumpToWorktreeIndex', index)
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
    mainWindow.webContents.send('window:close-requested')
  })

  const onConfirmClose = (): void => {
    windowCloseConfirmed = true
    if (!mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  }
  ipcMain.on(confirmCloseChannel, onConfirmClose)
  mainWindow.on('closed', () => {
    ipcMain.removeListener(confirmCloseChannel, onConfirmClose)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
