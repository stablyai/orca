import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import devIcon from '../../../resources/icon-dev.png?asset'
import type { Store } from '../persistence'

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:\/.*)?$/i

function normalizeExternalUrl(rawUrl: string): string | null {
  if (LOCAL_ADDRESS_PATTERN.test(rawUrl)) {
    try {
      return new URL(`http://${rawUrl}`).toString()
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? rawUrl : null
  } catch {
    return null
  }
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
      sandbox: true
    }
  })

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
    const externalUrl = normalizeExternalUrl(details.url)
    if (externalUrl) {
      shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  // Block ALL in-window navigations to prevent remote pages from inheriting
  // the privileged preload bridge (PTY, filesystem, etc.).
  // In dev mode, allow navigations to the local dev server (e.g. HMR reloads).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalUrl(url)

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

    const modifierPressed = process.platform === 'darwin' ? input.meta : input.control
    if (!modifierPressed || input.alt) {
      return
    }

    if (input.key === '=' || input.key === '+') {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'in')
    } else if (input.key === '-') {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'out')
    } else if (input.key === '0' && !input.shift) {
      event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'reset')
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
