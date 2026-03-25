import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import devIcon from '../../../resources/icon-dev.png?asset'
import type { Store } from '../persistence'

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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(details.url)
      }
    } catch {
      // ignore malformed URLs
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) {
      event.preventDefault()
    }
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
