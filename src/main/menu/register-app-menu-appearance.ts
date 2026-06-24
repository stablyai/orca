import type { MenuItemConstructorOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'

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

type BuildAppearanceSubmenuOptions = {
  appearance: AppearanceMenuState
  shortcutLabel: (actionId: 'sidebar.left.toggle' | 'sidebar.right.toggle') => string
  onToggleLeftSidebar: (window?: Electron.BaseWindow | null) => void
  onToggleRightSidebar: (window?: Electron.BaseWindow | null) => void
  onToggleAppearance: (key: AppearanceMenuKey, window?: Electron.BaseWindow | null) => void
}

export function buildAppearanceSubmenu({
  appearance,
  shortcutLabel,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onToggleAppearance
}: BuildAppearanceSubmenuOptions): MenuItemConstructorOptions {
  // Why: Electron does not reactively update checked values, so the parent
  // menu rebuild reads the latest appearance state before calling this builder.
  return {
    label: translateMain('menu.appearance', 'Appearance'),
    submenu: [
      {
        // Why: display-only shortcut hint — not a real accelerator. Cmd/Ctrl+B
        // is intercepted in createMainWindow.ts so TipTap bold can win inside editors.
        label: `${translateMain('menu.toggleLeftSidebar', 'Toggle Left Sidebar')}\t${shortcutLabel('sidebar.left.toggle')}`,
        click: (_menuItem, window) => onToggleLeftSidebar(window)
      },
      {
        // Why: display-only shortcut hint for the same renderer-owned shortcut path.
        label: `${translateMain('menu.toggleRightSidebar', 'Toggle Right Sidebar')}\t${shortcutLabel('sidebar.right.toggle')}`,
        click: (_menuItem, window) => onToggleRightSidebar(window)
      },
      {
        label: translateMain('menu.showStatusBar', 'Show Status Bar'),
        type: 'checkbox',
        checked: appearance.statusBarVisible,
        click: (_menuItem, window) => onToggleAppearance('statusBarVisible', window)
      },
      { type: 'separator' },
      {
        label: translateMain('menu.showTasksButton', 'Show Tasks Button'),
        type: 'checkbox',
        checked: appearance.showTasksButton,
        click: (_menuItem, window) => onToggleAppearance('showTasksButton', window)
      },
      {
        label: translateMain('menu.showAutomationsButton', 'Show Automations Button'),
        type: 'checkbox',
        checked: appearance.showAutomationsButton,
        click: (_menuItem, window) => onToggleAppearance('showAutomationsButton', window)
      },
      {
        label: translateMain('menu.showMobileButton', 'Show Orca Mobile Button'),
        type: 'checkbox',
        checked: appearance.showMobileButton,
        click: (_menuItem, window) => onToggleAppearance('showMobileButton', window)
      },
      {
        label: translateMain('menu.showTitlebarAppName', 'Show Titlebar App Name'),
        type: 'checkbox',
        checked: appearance.showTitlebarAppName,
        click: (_menuItem, window) => onToggleAppearance('showTitlebarAppName', window)
      }
    ]
  }
}
