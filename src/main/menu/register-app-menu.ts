import { BrowserWindow, Menu, app } from 'electron'
import { keybindingCatalog } from '../../shared/keybindings/keybinding-catalog'
import { buildEffectiveKeymap } from '../../shared/keybindings/effective-keymap'
import { getPrimaryChordLabel } from '../../shared/keybindings/keybinding-display'
import type {
  CanonicalChord,
  EffectiveKeymap,
  KeybindingActionId,
  KeybindingPlatform
} from '../../shared/keybindings/keybinding-types'

export type AppearanceMenuState = {
  showTasksButton: boolean
  showTitlebarAppName: boolean
  statusBarVisible: boolean
}

export type AppearanceMenuKey = keyof AppearanceMenuState

type RegisterAppMenuOptions = {
  onOpenSettings: () => void
  onCheckForUpdates: (options: { includePrerelease: boolean }) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  onToggleAppearance: (key: AppearanceMenuKey) => void
  getAppearanceState: () => AppearanceMenuState
  getEffectiveKeymap?: () => EffectiveKeymap
}

function getElectronAccelerators(keymap: EffectiveKeymap, actionId: KeybindingActionId): string[] {
  const binding = keymap.bindings.find((candidate) => candidate.id === actionId)
  return binding?.chords.map(chordToElectronAccelerator).filter((value) => value !== null) ?? []
}

function chordToElectronAccelerator(chord: CanonicalChord): string | null {
  const parts: string[] = []
  if (chord.cmd) {
    parts.push('Cmd')
  }
  if (chord.ctrl) {
    parts.push('Ctrl')
  }
  if (chord.alt) {
    parts.push('Alt')
  }
  if (chord.shift) {
    parts.push('Shift')
  }

  const key = chordKeyToElectronAcceleratorKey(chord.key)
  if (!key) {
    return null
  }
  parts.push(key)
  return parts.join('+')
}

function chordKeyToElectronAcceleratorKey(key: string): string | null {
  switch (key) {
    case 'arrowleft':
      return 'Left'
    case 'arrowright':
      return 'Right'
    case 'arrowup':
      return 'Up'
    case 'arrowdown':
      return 'Down'
    case 'escape':
      return 'Esc'
    case 'enter':
      return 'Enter'
    case 'backspace':
      return 'Backspace'
    case 'delete':
      return 'Delete'
    case 'insert':
      return 'Insert'
    case 'space':
      return 'Space'
    case '+':
      return 'Plus'
    default:
      return key.length === 1 ? key.toUpperCase() : key
  }
}

function buildAndApplyMenu(options: RegisterAppMenuOptions): void {
  const {
    onOpenSettings,
    onCheckForUpdates,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance,
    getAppearanceState,
    getEffectiveKeymap
  } = options

  const isMac = process.platform === 'darwin'
  const keybindingPlatform: KeybindingPlatform = isMac
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux'
  const effectiveKeymap =
    getEffectiveKeymap?.() ??
    buildEffectiveKeymap({ catalog: keybindingCatalog, platform: keybindingPlatform })
  const appearance = getAppearanceState()
  const zoomInAccelerators = getElectronAccelerators(effectiveKeymap, 'window.zoomIn')
  const zoomOutAccelerators = getElectronAccelerators(effectiveKeymap, 'window.zoomOut')
  const zoomResetAccelerators = getElectronAccelerators(effectiveKeymap, 'window.zoomReset')

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
        label: `Toggle Left Sidebar\t${getPrimaryChordLabel(effectiveKeymap, 'sidebar.left.toggle')}`,
        click: () => onToggleLeftSidebar()
      },
      {
        // Why: display-only shortcut hint for the same reason as above.
        label: `Toggle Right Sidebar\t${getPrimaryChordLabel(effectiveKeymap, 'sidebar.right.toggle')}`,
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
        accelerator: zoomResetAccelerators[0],
        // Why: Some keyboard layouts/platforms intercept Cmd/Ctrl+zoom chords
        // before before-input-event fires. Binding the menu accelerator gives
        // us a reliable cross-platform fallback path.
        click: () => onZoomReset()
      },
      {
        label: 'Zoom In',
        accelerator: zoomInAccelerators[0],
        click: () => onZoomIn()
      },
      {
        label: 'Zoom Out',
        accelerator: zoomOutAccelerators[0],
        click: () => onZoomOut()
      },
      {
        label: 'Zoom Out (Shift Alias)',
        // Why: Some Linux keyboard layouts report the top-row minus chord as
        // an underscore accelerator. Keep this hidden alias so Ctrl+- and
        // Ctrl+_ can both route to terminal zoom out.
        accelerator: zoomOutAccelerators[1],
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
        label: `Open Worktree Palette\t${getPrimaryChordLabel(effectiveKeymap, 'worktree.palette.toggle')}`
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

  // Why: Windows/Linux have no app-named menu, so About + Check for Updates
  // go into a Help menu — the standard place for those entries on those
  // platforms. On macOS the system "About Orca" and "Check for Updates"
  // already sit under the app menu, so we don't duplicate them here.
  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [{ role: 'about' }, checkForUpdatesItem]
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    ...(isMac ? [] : [helpMenu])
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
