import { app, shell, BrowserWindow, Menu, nativeImage, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import devIcon from '../../resources/icon-dev.png?asset'

// Packaged Electron apps on macOS/Linux don't inherit the user's shell PATH,
// so CLI tools installed via Homebrew / nix / snap / etc. (e.g. `gh`) can't be
// found. Augment PATH once at startup with common binary directories.
// Windows GUI apps inherit the full system PATH, so no fix is needed there.
if (app.isPackaged && process.platform !== 'win32') {
  const home = process.env.HOME ?? ''
  const extraPaths = [
    '/opt/homebrew/bin', // macOS ARM Homebrew
    '/opt/homebrew/sbin',
    '/usr/local/bin', // macOS Intel Homebrew / common
    '/usr/local/sbin',
    '/snap/bin', // Ubuntu snap packages
    '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
    '/nix/var/nix/profiles/default/bin' // nix (system)
  ]
  if (home) {
    extraPaths.push(
      join(home, '.local/bin'), // Linux user-local (pipx, cargo, etc.)
      join(home, '.nix-profile/bin') // nix (user)
    )
  }
  const sep = ':'
  const currentPath = process.env.PATH ?? ''
  const existing = new Set(currentPath.split(sep))
  const missing = extraPaths.filter((p) => !existing.has(p))
  if (missing.length) {
    process.env.PATH = [...missing, ...currentPath.split(sep).filter(Boolean)].join(sep)
  }
}

import { Store } from './persistence'
import { registerRepoHandlers } from './ipc/repos'
import { registerWorktreeHandlers } from './ipc/worktrees'
import { registerPtyHandlers, killAllPty } from './ipc/pty'
import { registerGitHubHandlers } from './ipc/github'
import { registerSettingsHandlers } from './ipc/settings'
import { registerShellHandlers } from './ipc/shell'
import { registerSessionHandlers } from './ipc/session'
import { registerUIHandlers } from './ipc/ui'
import { registerFilesystemHandlers } from './ipc/filesystem'
import { warmSystemFontFamilies } from './system-fonts'
import {
  setupAutoUpdater,
  checkForUpdates,
  checkForUpdatesFromMenu,
  getUpdateStatus,
  quitAndInstall
} from './updater'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null

// Enable WebGPU in Electron
app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaGraphite')
app.commandLine.appendSwitch('enable-unsafe-webgpu')

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createWindow(): BrowserWindow {
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
      sandbox: false
    }
  })

  // Restore persisted zoom before the window is shown. dom-ready fires
  // before ready-to-show, so the user never sees the wrong zoom level.
  // Always set explicitly to override Chromium's own zoom cache.
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // File drag-and-drop: the preload script handles the drop event (because
  // File.path is only available there), sends paths here, and we relay to renderer.
  ipcMain.on('terminal:file-dropped-from-preload', (_event, args: { paths: string[] }) => {
    if (!mainWindow.isDestroyed()) {
      for (const p of args.paths) {
        mainWindow.webContents.send('terminal:file-drop', { path: p })
      }
    }
  })

  // Safety net: block any file:// navigation that might slip through
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  // Handle zoom shortcuts reliably via before-input-event
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod || input.alt) {
      return
    }
    if (input.key === '=' || input.key === '+') {
      _event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'in')
    } else if (input.key === '-') {
      _event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'out')
    } else if (input.key === '0' && !input.shift) {
      _event.preventDefault()
      mainWindow.webContents.send('terminal:zoom', 'reset')
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.stablyai.orca')
  app.setName('Orca')

  if (process.platform === 'darwin' && is.dev) {
    const dockIcon = nativeImage.createFromPath(devIcon)
    app.dock?.setIcon(dockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Override default menu to prevent Cmd+W from closing the window.
  // The renderer handles Cmd+W to close terminal panes instead.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => checkForUpdatesFromMenu()
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send('ui:openSettings')
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          registerAccelerator: false
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          registerAccelerator: false
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          registerAccelerator: false
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Initialize persistence
  store = new Store()

  // Apply persisted theme before creating the window so that:
  // 1. BrowserWindow gets the correct backgroundColor (no white flash)
  // 2. nativeTheme.themeSource makes prefers-color-scheme report correctly
  //    so the renderer's applySystemTheme() picks the right mode immediately
  const theme = store.getSettings().theme ?? 'system'
  nativeTheme.themeSource = theme

  // Create window
  mainWindow = createWindow()

  // Register all IPC handlers
  registerRepoHandlers(mainWindow, store)
  registerWorktreeHandlers(mainWindow, store)
  registerPtyHandlers(mainWindow)
  registerGitHubHandlers()
  registerSettingsHandlers(store)
  registerShellHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerFilesystemHandlers(store)
  warmSystemFontFamilies()
  setupAutoUpdater(mainWindow)

  // Updater IPC
  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())

  // macOS re-activate
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      registerPtyHandlers(mainWindow)
    }
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
app.on('before-quit', () => {
  killAllPty()
  store?.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
