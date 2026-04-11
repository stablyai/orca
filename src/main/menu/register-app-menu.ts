import { BrowserWindow, Menu, app } from 'electron'

type RegisterAppMenuOptions = {
  onOpenSettings: () => void
  onCheckForUpdates: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
}

export function registerAppMenu({
  onOpenSettings,
  onCheckForUpdates,
  onZoomIn,
  onZoomOut,
  onZoomReset
}: RegisterAppMenuOptions): void {
  const reloadFocusedWindow = (ignoreCache: boolean): void => {
    const webContents = BrowserWindow.getFocusedWindow()?.webContents
    if (!webContents) {
      return
    }

    if (ignoreCache) {
      webContents.reloadIgnoringCache()
      return
    }

    webContents.reload()
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => onCheckForUpdates()
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => onOpenSettings()
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
        {
          label: 'Reload',
          click: () => reloadFocusedWindow(false)
        },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => reloadFocusedWindow(true)
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Reset Size',
          accelerator: 'CmdOrCtrl+0',
          // Why: Some keyboard layouts/platforms intercept Cmd/Ctrl+zoom chords
          // before before-input-event fires. Binding the menu accelerator gives
          // us a reliable cross-platform fallback path.
          click: () => onZoomReset()
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => onZoomIn()
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => onZoomOut()
        },
        {
          label: 'Zoom Out (Shift Alias)',
          // Why: Some Linux keyboard layouts report the top-row minus chord as
          // an underscore accelerator. Keep this hidden alias so Ctrl+- and
          // Ctrl+_ can both route to terminal zoom out.
          accelerator: 'CmdOrCtrl+_',
          visible: false,
          click: () => onZoomOut()
        },
        { type: 'separator' },
        {
          // Why: display-only shortcut hint — do NOT set `accelerator` here.
          // Menu accelerators intercept key events at the main-process level
          // before the renderer's keydown handler fires. The overlay
          // mutual-exclusion logic (which runs in the renderer) would be
          // bypassed if this were a real accelerator binding.
          label: `Open Worktree Palette\t${process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+Shift+J'}`
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
}
