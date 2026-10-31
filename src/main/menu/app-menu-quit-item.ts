import { translateMain } from '../i18n/main-i18n'
import { hasFocusedDesktopHoldQuitSurface } from '../window/desktop-hold-quit-surface'

type AppMenuQuitItem = Omit<Electron.MenuItemConstructorOptions, 'click'> & {
  click?: () => void
}

// The label is localized, so E2E finds the item by id.
const QUIT_AND_STOP_ALL_SESSIONS_MENU_ITEM_ID = 'quit-and-stop-all-sessions'

export type AppMenuQuitHandlers = {
  holdQuitShortcut?: { isEnabled: () => boolean; quit: () => void }
  onQuit?: () => void
  /** Confirm, then quit with every terminal session stopped; omitted where the item must not show (serve mode). */
  onQuitAndStopAllSessions?: () => void
}

/** Use onQuit so persistent hosts can refuse user Quit; the native guard covers only macOS. */
export function createAppMenuQuitItem(
  onQuit: (() => void) | undefined,
  macAppName?: string,
  holdShortcut?: { isEnabled: () => boolean; quit: () => void }
): AppMenuQuitItem {
  const exitLabel = macAppName === undefined ? translateMain('menu.exit', 'Exit') : undefined
  if (
    process.platform === 'darwin' &&
    holdShortcut?.isEnabled() &&
    hasFocusedDesktopHoldQuitSurface()
  ) {
    return {
      label: `${translateMain('menu.quitApp', `Quit ${macAppName}`, { appName: macAppName })}\t⌘Q`,
      click: () => holdShortcut.quit()
    }
  }
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

/** Shared by the app menu and tray; toolTip is macOS-only, the confirmation explains it elsewhere. */
export function quitAndStopAllSessionsMenuText(): Pick<
  Electron.MenuItemConstructorOptions,
  'label' | 'toolTip'
> {
  return {
    label: translateMain('menu.quitAndStopAllSessions', 'Quit Completely...'),
    toolTip: translateMain(
      'menu.quitAndStopAllSessionsTooltip',
      'Also stops every terminal session, including running agents. Plain Quit keeps them running so Orca reattaches on next launch.'
    )
  }
}

/** Quit Completely (when offered) directly above Quit, so Quit stays the last entry. */
export function createAppMenuQuitItems(
  handlers: AppMenuQuitHandlers,
  macAppName?: string
): Electron.MenuItemConstructorOptions[] {
  const quitItem = createAppMenuQuitItem(handlers.onQuit, macAppName, handlers.holdQuitShortcut)
  const { onQuitAndStopAllSessions } = handlers
  if (!onQuitAndStopAllSessions) {
    return [quitItem]
  }
  return [
    {
      id: QUIT_AND_STOP_ALL_SESSIONS_MENU_ITEM_ID,
      ...quitAndStopAllSessionsMenuText(),
      // No accelerator: macOS reserves ⌥⌘Q for "Quit and Keep Windows", the opposite intent.
      click: () => onQuitAndStopAllSessions()
    },
    quitItem
  ]
}
