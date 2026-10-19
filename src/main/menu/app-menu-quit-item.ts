import { translateMain } from '../i18n/main-i18n'

/**
 * The app menu's Quit entry: "Quit <macAppName>" in the macOS app menu, else File > Exit.
 * Why a handler instead of role 'quit': a host that must not exit on a user Quit
 * (`orca serve`, #15537) supplies `onQuit`; the native-quit guard only covers macOS.
 */
export function createAppMenuQuitItem(
  onQuit: (() => void) | undefined,
  macAppName?: string
): Electron.MenuItemConstructorOptions {
  const exitLabel = macAppName === undefined ? translateMain('menu.exit', 'Exit') : undefined
  if (!onQuit) {
    return { role: 'quit', ...(exitLabel ? { label: exitLabel } : {}) }
  }
  return {
    label:
      exitLabel ?? translateMain('menu.quitApp', `Quit ${macAppName}`, { appName: macAppName }),
    // Same accelerator Electron gives role 'quit' (none on Windows).
    ...(process.platform === 'win32' ? {} : { accelerator: 'CmdOrCtrl+Q' }),
    click: () => onQuit()
  }
}
