import { Menu, app } from 'electron'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../shared/keybindings'
import { translateMain } from '../i18n/main-i18n'
import {
  buildAppearanceSubmenu,
  getNextDefaultOnAppearanceSettingValue,
  type AppearanceMenuKey,
  type AppearanceMenuState
} from './register-app-menu-appearance'
import { reloadMenuTarget } from './menu-target-web-contents'

export { getNextDefaultOnAppearanceSettingValue }

type RegisterAppMenuOptions = {
  multiWindowEnabled: boolean
  onNewWindow: () => void
  onOpenSettings: (window?: Electron.BaseWindow | null) => void
  onOpenSetupGuide: (window?: Electron.BaseWindow | null) => void
  onOpenFeatureTour: (window?: Electron.BaseWindow | null) => void
  onOpenCrashReport: (window?: Electron.BaseWindow | null) => void
  onCheckForUpdates: (options: { includePrerelease: boolean }) => void
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  onZoomIn: (window?: Electron.BaseWindow | null) => void
  onZoomOut: (window?: Electron.BaseWindow | null) => void
  onZoomReset: (window?: Electron.BaseWindow | null) => void
  onToggleLeftSidebar: (window?: Electron.BaseWindow | null) => void
  onToggleRightSidebar: (window?: Electron.BaseWindow | null) => void
  onToggleAppearance: (key: AppearanceMenuKey, window?: Electron.BaseWindow | null) => void
  getAppearanceState: () => AppearanceMenuState
  getKeybindings?: () => KeybindingOverrides | undefined
}

function buildAndApplyMenu(options: RegisterAppMenuOptions): void {
  const {
    onOpenSettings,
    onNewWindow,
    multiWindowEnabled,
    onOpenSetupGuide,
    onOpenFeatureTour,
    onOpenCrashReport,
    onCheckForUpdates,
    onBeforeReload,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance,
    getAppearanceState,
    getKeybindings
  } = options

  const isMac = process.platform === 'darwin'
  const appearance = getAppearanceState()
  const shortcutLabel = (actionId: KeybindingActionId): string => {
    const bindings = getEffectiveKeybindingsForAction(
      actionId,
      process.platform,
      getKeybindings?.()
    )
    return formatKeybindingList(bindings, process.platform)
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
    label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
    click: checkForUpdatesClick
  }

  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: `${translateMain('menu.settings', 'Settings')}\t${shortcutLabel('app.settings')}`,
    click: (_menuItem, window) => onOpenSettings(window)
  }

  const newWindowItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.newWindow', 'New Window'),
    click: () => onNewWindow()
  }

  const featureTourItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.exploreOrca', 'Explore Orca'),
    click: (_menuItem, window) => onOpenFeatureTour(window)
  }

  const setupGuideItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.gettingStarted', 'Getting Started with Orca'),
    click: (_menuItem, window) => onOpenSetupGuide(window)
  }

  const crashReportItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.reportCrash', 'Report Crash...'),
    click: (_menuItem, window) => onOpenCrashReport(window)
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
    label: translateMain('menu.file', 'File'),
    // Why: on Windows/Linux there is no app-named menu, so Settings and
    // Quit live under File — matching the common platform convention and
    // keeping all user-facing actions reachable from the in-window menu bar.
    submenu: [
      // Why: the multi-window code path is still experimental and is read at
      // startup. Hiding the entry keeps normal users on the single-window path
      // until they opt in and restart.
      ...(multiWindowEnabled
        ? ([newWindowItem, { type: 'separator' }] satisfies Electron.MenuItemConstructorOptions[])
        : []),
      // Why: on Windows/Linux there is no app-named menu, so Settings and
      // Quit live under File — matching the common platform convention and
      // keeping all user-facing actions reachable from the in-window menu bar.
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            settingsItem,
            { type: 'separator' },
            { role: 'quit', label: translateMain('menu.exit', 'Exit') }
          ] satisfies Electron.MenuItemConstructorOptions[]))
    ]
  }
  const shouldIncludeFileMenu =
    Array.isArray(fileMenu.submenu) && fileMenu.submenu.some((item) => item.type !== 'separator')

  const editMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.edit', 'Edit'),
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

  const appearanceSubmenu = buildAppearanceSubmenu({
    appearance,
    shortcutLabel,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance
  })

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.view', 'View'),
    submenu: [
      {
        label: translateMain('menu.reload', 'Reload'),
        click: (_menuItem, window) => reloadMenuTarget(window, false, onBeforeReload)
      },
      {
        label: `${translateMain('menu.forceReload', 'Force Reload')}\t${shortcutLabel('app.forceReload')}`,
        click: (_menuItem, window) => reloadMenuTarget(window, true, onBeforeReload)
      },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      {
        label: `${translateMain('menu.resetSize', 'Reset Size')}\t${shortcutLabel('zoom.reset')}`,
        click: (_menuItem, window) => onZoomReset(window)
      },
      {
        label: `${translateMain('menu.zoomIn', 'Zoom In')}\t${shortcutLabel('zoom.in')}`,
        click: (_menuItem, window) => onZoomIn(window)
      },
      {
        label: `${translateMain('menu.zoomOut', 'Zoom Out')}\t${shortcutLabel('zoom.out')}`,
        click: (_menuItem, window) => onZoomOut(window)
      },
      { type: 'separator' },
      {
        // Why: display-only shortcut hint — do NOT set `accelerator` here.
        // Menu accelerators intercept key events at the main-process level
        // before the renderer's keydown handler fires. The overlay
        // mutual-exclusion logic (which runs in the renderer) would be
        // bypassed if this were a real accelerator binding.
        label: `${translateMain('menu.openWorktreePalette', 'Open Worktree Palette')}\t${shortcutLabel('worktree.palette')}`
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      appearanceSubmenu
    ]
  }

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.window', 'Window'),
    submenu: [{ role: 'minimize' }, { role: 'zoom' }]
  }

  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.help', 'Help'),
    submenu: [
      crashReportItem,
      { type: 'separator' },
      featureTourItem,
      setupGuideItem,
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
    ...(shouldIncludeFileMenu ? [fileMenu] : []),
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
