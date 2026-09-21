import type { BrowserWindow } from 'electron'
import { invalidatePersistedWindowsPathCache } from './windows-environment-path'

export const WINDOWS_SETTING_CHANGE_MESSAGE = 0x001a

type WindowsMessageWindow = Pick<BrowserWindow, 'hookWindowMessage'>

export function installWindowsPathRegistryChangeListener(
  window: Partial<WindowsMessageWindow>,
  options: { invalidate?: () => void; platform?: NodeJS.Platform } = {}
): void {
  if ((options.platform ?? process.platform) !== 'win32' || !window.hookWindowMessage) {
    return
  }
  window.hookWindowMessage(
    WINDOWS_SETTING_CHANGE_MESSAGE,
    options.invalidate ?? invalidatePersistedWindowsPathCache
  )
}
