import { BrowserWindow, Menu, app } from 'electron'
import {
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../shared/keybindings'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import { translateMain } from '../i18n/main-i18n'
import { createAppMenuSelectionItem, resolveNativeEditTarget } from './app-menu-selection-item'
import { createAppMenuQuitItems, type AppMenuQuitHandlers } from './app-menu-quit-item'
import { createAppMenuReloadAndDevToolsItems } from './app-menu-reload-devtools-items'
import { appMenuShortcutHint } from './app-menu-shortcut-hint'
import { createAppWindowMenu } from './app-menu-window'

export type AppearanceMenuState = {
  showTasksButton: boolean
  showAutomationsButton: boolean
  showMobileButton: boolean
  showTitlebarAppName: boolean
  statusBarVisible: boolean
}

export type AppearanceMenuKey = keyof AppearanceMenuState

export function getNextDefaultOnAppearanceSettingValue(current: boolean | undefined): boolean {
  return !(current !== false)
}

type RegisterAppMenuOptions = AppMenuQuitHandlers & {
  onOpenSettings: () => void
  onOpenSetupGuide: (window?: Electron.BaseWindow | null) => void
  onOpenFeatureTour: (window?: Electron.BaseWindow | null) => void
  onOpenCrashReport: (window?: Electron.BaseWindow | null) => void
  onCheckForUpdates: (options: UpdateCheckOptions) => void
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  onToggleAppearance: (key: AppearanceMenuKey) => void
  getAppearanceState: () => AppearanceMenuState
  getKeybindings?: () => KeybindingOverrides | undefined
  toggleFocusedPageDevTools?: (focused: Electron.WebContents) => boolean
  // app.name stays stable for Keychain; menus use the per-branch development label.
  appMenuLabel?: string
}

function buildAndApplyMenu(options: RegisterAppMenuOptions): void {
  const {
    onOpenSettings,
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
  const shortcutBindings = (actionId: KeybindingActionId): string[] =>
    getEffectiveKeybindingsForAction(actionId, process.platform, getKeybindings?.())
  const shortcutHint = (label: string, actionId: KeybindingActionId) =>
    appMenuShortcutHint(label, shortcutBindings(actionId), process.platform)

  // Share modifier-click release-channel routing across platform-specific update menu locations.
  const checkForUpdatesClick: Electron.MenuItemConstructorOptions['click'] = (
    _menuItem,
    _window,
    event
  ) => {
    const modifierClick = !event.triggeredByAccelerator
    const localBuild = isMac && modifierClick && event.altKey === true
    const includePerfPrerelease =
      !localBuild && modifierClick && (isMac ? event.metaKey === true : event.ctrlKey === true)
    const includePrerelease = !localBuild && modifierClick && event.shiftKey === true
    onCheckForUpdates({
      includePrerelease,
      includePerfPrerelease,
      ...(localBuild ? { localBuild: true } : {})
    })
  }

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
    click: checkForUpdatesClick
  }

  const settingsLabel = translateMain('menu.settings', 'Settings')
  const settingsBindings = shortcutBindings('app.settings')
  const settingsItem: Electron.MenuItemConstructorOptions = {
    ...(settingsBindings.length
      ? appMenuShortcutHint(settingsLabel, settingsBindings, process.platform)
      : { label: settingsLabel }),
    click: () => onOpenSettings()
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

  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: options.appMenuLabel ?? app.name,
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
      ...createAppMenuQuitItems(options, options.appMenuLabel ?? app.name)
    ]
  }

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.file', 'File'),
    submenu: [settingsItem, { type: 'separator' }, ...createAppMenuQuitItems(options)]
  }

  // Keep menu hints while non-macOS Ctrl+Z/Ctrl+Y reach focused terminal or DOM controls.
  const undoRedoOptions: Electron.MenuItemConstructorOptions = isMac
    ? {}
    : { registerAccelerator: false }
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.edit', 'Edit'),
    submenu: [
      { role: 'undo', ...undoRedoOptions },
      { role: 'redo', ...undoRedoOptions },
      { type: 'separator' },
      { role: 'cut' },
      createAppMenuSelectionItem({
        action: 'copy',
        label: translateMain('menu.copy', 'Copy'),
        isMac
      }),
      {
        label: translateMain('menu.paste', 'Paste'),
        accelerator: 'CmdOrCtrl+V',
        click: () => {
          // Electron paste cannot resolve ownership among Orca terminal/chat surfaces.
          const focusedWindow = BrowserWindow.getFocusedWindow()
          if (focusedWindow) {
            // Focused DevTools must own paste over the renderer's last-focused terminal (#16285).
            const nativeTarget = resolveNativeEditTarget(focusedWindow)
            if (nativeTarget) {
              return nativeTarget.paste()
            }
            focusedWindow.webContents.send('ui:appMenuPaste')
            return
          }

          // Native macOS panels leave no focused BrowserWindow; preserve first-responder Cmd+V.
          if (isMac) {
            Menu.sendActionToFirstResponder('paste:')
          }
        }
      },
      createAppMenuSelectionItem({
        action: 'select-all',
        label: translateMain('menu.selectAll', 'Select All'),
        isMac
      })
    ]
  }

  // Electron menus are not reactive; rebuild after appearance settings change.
  const appearanceSubmenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.appearance', 'Appearance'),
    submenu: [
      {
        // Display hints only: native accelerators bypass markdown bold handling and renderer-owned sidebar state.
        ...shortcutHint(
          translateMain('menu.toggleLeftSidebar', 'Toggle Left Sidebar'),
          'sidebar.left.toggle'
        ),
        click: () => onToggleLeftSidebar()
      },
      {
        ...shortcutHint(
          translateMain('menu.toggleRightSidebar', 'Toggle Right Sidebar'),
          'sidebar.right.toggle'
        ),
        click: () => onToggleRightSidebar()
      },
      {
        label: translateMain('menu.showStatusBar', 'Show Status Bar'),
        type: 'checkbox',
        checked: appearance.statusBarVisible,
        click: () => onToggleAppearance('statusBarVisible')
      },
      { type: 'separator' },
      {
        label: translateMain('menu.showTasksButton', 'Show Tasks Button'),
        type: 'checkbox',
        checked: appearance.showTasksButton,
        click: () => onToggleAppearance('showTasksButton')
      },
      {
        label: translateMain('menu.showAutomationsButton', 'Show Automations Button'),
        type: 'checkbox',
        checked: appearance.showAutomationsButton,
        click: () => onToggleAppearance('showAutomationsButton')
      },
      {
        label: translateMain('menu.showMobileButton', 'Show Orca Mobile Button'),
        type: 'checkbox',
        checked: appearance.showMobileButton,
        click: () => onToggleAppearance('showMobileButton')
      },
      {
        label: translateMain('menu.showTitlebarAppName', 'Show Titlebar App Name'),
        type: 'checkbox',
        checked: appearance.showTitlebarAppName,
        click: () => onToggleAppearance('showTitlebarAppName')
      }
    ]
  }

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.view', 'View'),
    submenu: [
      ...createAppMenuReloadAndDevToolsItems({
        forceReloadBindings: shortcutBindings('app.forceReload'),
        onBeforeReload,
        toggleFocusedPageDevTools: options.toggleFocusedPageDevTools
      }),
      { type: 'separator' },
      {
        ...shortcutHint(translateMain('menu.resetSize', 'Reset Size'), 'zoom.reset'),
        click: () => onZoomReset()
      },
      {
        ...shortcutHint(translateMain('menu.zoomIn', 'Zoom In'), 'zoom.in'),
        click: () => onZoomIn()
      },
      {
        ...shortcutHint(translateMain('menu.zoomOut', 'Zoom Out'), 'zoom.out'),
        click: () => onZoomOut()
      },
      { type: 'separator' },
      // Registered accelerators would bypass the renderer's overlay mutual-exclusion handling.
      shortcutHint(
        translateMain('menu.openWorktreePalette', 'Open Worktree Palette'),
        'worktree.palette'
      ),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      appearanceSubmenu
    ]
  }

  const windowMenu = createAppWindowMenu(translateMain('menu.window', 'Window'), isMac)

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
    ...(isMac ? [] : [fileMenu]),
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

/** Rebuild from the latest options because Electron does not reactively update checked state. */
export function rebuildAppMenu(): void {
  if (lastRegisterOptions) {
    buildAndApplyMenu(lastRegisterOptions)
  }
}
