import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { insertDictationTextIntoGuest } from '../../browser/dictation/browser-guest-dictation-text'
import { pageGuest } from './browser-guest-view-ipc'

export function registerBrowserDictationHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('browser:insertDictationText')
  }
  ipc.handle(
    'browser:insertDictationText',
    (event, args: { browserPageId: string; text: unknown }): Promise<boolean> | false => {
      const guest = pageGuest(event, args?.browserPageId)
      return guest && typeof args.text === 'string' && args.text
        ? insertDictationTextIntoGuest(guest, args.text).catch(() => false)
        : false
    }
  )
}
