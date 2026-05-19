import { BrowserWindow, Menu, app } from 'electron'

export type AppearanceMenuState = {
  showTasksButton: boolean
  showTitlebarAppName: boolean
  statusBarVisible: boolean
}

export type AppearanceMenuKey = keyof AppearanceMenuState

type RegisterAppMenuOptions = {
  onOpenSettings: () => void
  onOpenFeatureTour: (window?: Electron.BaseWindow | null) => void
  onOpenCrashReport: (window?: Electron.BaseWindow | null) => void
  onCheckForUpdates: (options: { includePrerelease: boolean }) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  onToggleAppearance: (key: AppearanceMenuKey) => void
  getAppearanceState: () => AppearanceMenuState
}

function buildAndApplyMenu(options: RegisterAppMenuOptions): void {
  const {
    onOpenSettings,
    onOpenFeatureTour,
    onOpenCrashReport,
    onCheckForUpdates,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance,
    getAppearanceState
  } = options

  const isMac = process.platform === 'darwin'
  const appearance = getAppearanceState()

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

  // Why: holding Shift while clicking Check for Updates opts this check into
  // the release-candidate channel. Extracted so both the macOS app-menu entry
  // and the Windows/Linux Help-menu entry share the exact same behavior.
  const checkForUpdatesClick: Electron.MenuItemConstructorOptions['click'] = (
    _menuItem,
    _window,
    event
  ) => {
    const includePrerelease = !event.triggeredByAccelerator && event.shiftKey === true
    onCheckForUpdates({ includePrerelease })
  }

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: 'Check for Updates...',
    click: checkForUpdatesClick
  }

  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => onOpenSettings()
  }

  const featureTourItem: Electron.MenuItemConstructorOptions = {
    label: 'Feature tour',
    click: (_menuItem, window) => onOpenFeatureTour(window)
  }

  const crashReportItem: Electron.MenuItemConstructorOptions = {
    label: 'Report Crash...',
    click: (_menuItem, window) => onOpenCrashReport(window)
  }

  const exportPdfItem: Electron.MenuItemConstructorOptions = {
    label: 'Export as PDF...',
    accelerator: 'CmdOrCtrl+Shift+E',
    click: () => {
      // Why: fire a one-way event into the focused renderer. The renderer
      // owns the knowledge of whether a markdown surface is active and
      // what DOM to extract — when no markdown surface is active this is
      // a silent no-op on that side (see design doc §4 "Renderer UI
      // trigger"). Keeping this as a send (not an invoke) avoids main
      // needing to reason about surface state. Using
      // BrowserWindow.getFocusedWindow() rather than the menu's
      // focusedWindow param avoids the BaseWindow typing gap.
      BrowserWindow.getFocusedWindow()?.webContents.send('export:requestPdf')
    }
  }

  // Why: the macOS app-menu (named after the app) is mandatory on darwin and
  // owns hide/hideOthers/unhide/services/quit roles that only make sense in
  // the system menu bar. On Windows/Linux that menu would render as a
  // redundant "Orca" entry with roles that don't apply, so we omit it there
  // and distribute its items across File / Help instead.
  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      checkForUpdatesItem,
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      exportPdfItem,
      // Why: on Windows/Linux there is no app-named menu, so Settings and
      // Quit live under File — matching the common platform convention and
      // keeping all user-facing actions reachable from the in-window menu bar.
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            settingsItem,
            { type: 'separator' },
            { role: 'quit', label: 'Exit' }
          ] satisfies Electron.MenuItemConstructorOptions[]))
    ]
  }

  const editMenu: Electron.MenuItemConstructorOptions = {
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
  }

  // Why: mirror VS Code's View > Appearance submenu so users can toggle
  // sidebar/status-bar/tasks-button/titlebar-activity from the menu bar as
  // well as from the settings pane. Electron doesn't reactively update
  // menu items when the backing state changes, so rebuildAppMenu() must be
  // called after every settings update — each build reads current
  // appearance state through getAppearanceState() and produces a fresh
  // template with accurate `checked` values.
  const appearanceSubmenu: Electron.MenuItemConstructorOptions = {
    label: 'Appearance',
    submenu: [
      {
        // Why: display-only shortcut hint — not a real accelerator. Cmd/Ctrl+B
        // is intercepted in createMainWindow.ts's before-input-event handler
        // with a TipTap-bold carve-out for markdown editors. Binding the
        // accelerator here would steal the chord before that carve-out can
        // fire. Sidebar open/closed lives in the renderer store (non-persisted),
        // so we forward a toggle request rather than mirroring state in main.
        label: `Toggle Left Sidebar\t${isMac ? 'Cmd+B' : 'Ctrl+B'}`,
        click: () => onToggleLeftSidebar()
      },
      {
        // Why: display-only shortcut hint for the same reason as above.
        label: `Toggle Right Sidebar\t${isMac ? 'Alt+Cmd+B' : 'Ctrl+Alt+B'}`,
        click: () => onToggleRightSidebar()
      },
      {
        label: 'Show Status Bar',
        type: 'checkbox',
        checked: appearance.statusBarVisible,
        click: () => onToggleAppearance('statusBarVisible')
      },
      { type: 'separator' },
      {
        label: 'Show Tasks Button',
        type: 'checkbox',
        checked: appearance.showTasksButton,
        click: () => onToggleAppearance('showTasksButton')
      },
      {
        label: 'Show Titlebar App Name',
        type: 'checkbox',
        checked: appearance.showTitlebarAppName,
        click: () => onToggleAppearance('showTitlebarAppName')
      }
    ]
  }

  const viewMenu: Electron.MenuItemConstructorOptions = {
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
        label: `Open Worktree Palette\t${isMac ? 'Cmd+J' : 'Ctrl+Shift+J'}`
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      appearanceSubmenu
    ]
  }

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }]
  }

  // Why: the feature tour is product education, so it belongs under Help on
  // every platform. macOS still keeps About/Updates in the app menu, while
  // Windows/Linux keep those entries here because they have no app menu.
  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      crashReportItem,
      { type: 'separator' },
      featureTourItem,
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            { role: 'about' },
            checkForUpdatesItem
          ] satisfies Electron.MenuItemConstructorOptions[]))
    ]
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let lastRegisterOptions: RegisterAppMenuOptions | null = null

export function registerAppMenu(options: RegisterAppMenuOptions): void {
  lastRegisterOptions = options
  buildAndApplyMenu(options)
}

/** Rebuild the application menu using the options from the most recent
 *  registerAppMenu call. Used to refresh checkbox `checked` state when
 *  settings that feed the Appearance submenu change, since Electron's
 *  menu items do not reactively re-render when the backing state updates. */
export function rebuildAppMenu(): void {
  if (lastRegisterOptions) {
    buildAndApplyMenu(lastRegisterOptions)
  }
}
