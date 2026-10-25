import { translateMain } from '../i18n/main-i18n'

// The label is localized, so E2E finds the item by id.
const QUIT_AND_STOP_ALL_SESSIONS_MENU_ITEM_ID = 'quit-and-stop-all-sessions'

export type AppMenuQuitHandlers = {
  onQuit?: () => void
  /** Confirm, then quit with every terminal session stopped; omitted where the item must not show (serve mode). */
  onQuitAndStopAllSessions?: () => void
}

/** Use onQuit so persistent hosts can refuse user Quit; the native guard covers only macOS. */
function createAppMenuQuitItem(
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

/** Quit and Stop All Sessions (when offered) directly above Quit, so Quit stays the last entry. */
export function createAppMenuQuitItems(
  handlers: AppMenuQuitHandlers,
  macAppName?: string
): Electron.MenuItemConstructorOptions[] {
  const quitItem = createAppMenuQuitItem(handlers.onQuit, macAppName)
  const { onQuitAndStopAllSessions } = handlers
  if (!onQuitAndStopAllSessions) {
    return [quitItem]
  }
  return [
    {
      id: QUIT_AND_STOP_ALL_SESSIONS_MENU_ITEM_ID,
      label: translateMain('menu.quitAndStopAllSessions', 'Quit and Stop All Sessions...'),
      // No accelerator: macOS reserves ⌥⌘Q for "Quit and Keep Windows", the opposite intent.
      click: () => onQuitAndStopAllSessions()
    },
    quitItem
  ]
}
