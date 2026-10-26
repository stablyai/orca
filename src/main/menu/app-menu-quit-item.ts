import { translateMain } from '../i18n/main-i18n'

/** Use onQuit so persistent hosts can refuse user Quit; the native guard covers only macOS. */
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
    // Match Electron quit accelerators, including no accelerator on Windows.
    ...(process.platform === 'win32' ? {} : { accelerator: 'CmdOrCtrl+Q' }),
    click: () => onQuit()
  }
}
