import { translateMain } from '../i18n/main-i18n'
import { nativeRoleLabel } from './native-role-label'

/** Builds the non-macOS File menu while preserving the host's optional Quit handler. */
export function createAppFileMenu(
  settingsItem: Electron.MenuItemConstructorOptions,
  onQuit?: () => void
): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.file', 'File'),
    submenu: [settingsItem, { type: 'separator' }, createAppMenuQuitItem(onQuit)]
  }
}

/**
 * The app menu's Quit entry: "Quit <macAppName>" in the macOS app menu, else File > Exit.
 * Why a handler instead of role 'quit': a host that must not exit on a user Quit
 * (`orca serve`, #15537) supplies `onQuit`; the native-quit guard only covers macOS.
 */
export function createAppMenuQuitItem(
  onQuit: (() => void) | undefined,
  macAppName?: string
): Electron.MenuItemConstructorOptions {
  const label =
    macAppName === undefined
      ? translateMain('menu.exit', 'Exit')
      : (nativeRoleLabel('menu.quit', 'Quit {{appName}}', { appName: macAppName }) ??
        translateMain('menu.quitApp', 'Quit {{appName}}', { appName: macAppName }))
  if (!onQuit) {
    return {
      role: 'quit',
      label:
        macAppName === undefined
          ? label
          : nativeRoleLabel('menu.quit', 'Quit {{appName}}', { appName: macAppName })
    }
  }
  return {
    label,
    // Same accelerator Electron gives role 'quit' (none on Windows).
    ...(process.platform === 'win32' ? {} : { accelerator: 'CmdOrCtrl+Q' }),
    click: () => onQuit()
  }
}
