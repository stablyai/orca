import { ipcMain } from 'electron'
import { insertDictationTextIntoGuest } from '../../browser/dictation/browser-guest-dictation-text'
import { pageGuest } from './browser-guest-view-ipc'

export function registerBrowserDictationHandlers(): void {
  ipcMain.removeHandler('browser:insertDictationText')
  ipcMain.handle(
    'browser:insertDictationText',
    (event, args: { browserPageId: string; text: unknown }): Promise<boolean> | false => {
      const guest = pageGuest(event, args?.browserPageId)
      return guest && typeof args.text === 'string' && args.text
        ? insertDictationTextIntoGuest(guest, args.text).catch(() => false)
        : false
    }
  )
}
