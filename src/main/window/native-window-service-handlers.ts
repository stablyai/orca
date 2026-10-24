import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  acknowledgePendingTccPromptNotice,
  consumePendingTccPromptNotice,
  dismissTccPromptNotice,
  releasePendingTccPromptNotice
} from '../macos-tcc-prompt-notice'

type WindowServices = {
  window: BrowserWindow
  token: number
  onReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
}

const windows = new Map<WebContents, WindowServices>()
let nextNoticeOwner = 100_000

export function registerNativeWindowServiceHandlers(
  window: BrowserWindow,
  onReload?: WindowServices['onReload']
): void {
  const renderer = window.webContents
  const entry = { window, onReload, token: ++nextNoticeOwner }
  windows.set(renderer, entry)
  const channels = [
    'app:reload',
    'macosTccPrompts:consumePending',
    'macosTccPrompts:acknowledgePending',
    'macosTccPrompts:releasePending',
    'macosTccPrompts:dismiss'
  ]
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }
  const owner = (sender: WebContents) => (!sender.isDestroyed() ? windows.get(sender) : undefined)
  ipcMain.handle('app:reload', (event) => {
    const target = owner(event.sender)
    if (!target || target.window.isDestroyed()) {
      return
    }
    target.onReload?.({ webContentsId: event.sender.id, ignoreCache: false })
    event.sender.reload()
  })
  ipcMain.handle('macosTccPrompts:consumePending', (event) => {
    const target = owner(event.sender)
    return target ? consumePendingTccPromptNotice(target.token) : null
  })
  ipcMain.handle('macosTccPrompts:acknowledgePending', (event, claimId: number) => {
    const target = owner(event.sender)
    if (target && Number.isSafeInteger(claimId)) {
      acknowledgePendingTccPromptNotice(target.token, claimId)
    }
  })
  ipcMain.handle('macosTccPrompts:releasePending', (event, claimId: number) => {
    const target = owner(event.sender)
    if (target && Number.isSafeInteger(claimId)) {
      releasePendingTccPromptNotice(target.token, claimId)
    }
  })
  ipcMain.handle('macosTccPrompts:dismiss', (event) => {
    if (owner(event.sender)) {
      dismissTccPromptNotice()
    }
  })
  const release = () => releasePendingTccPromptNotice(entry.token)
  renderer.on('did-start-loading', () => {
    if (renderer.isLoadingMainFrame()) {
      release()
    }
  })
  renderer.on('render-process-gone', release)
  renderer.once('destroyed', () => {
    release()
    if (windows.get(renderer) === entry) {
      windows.delete(renderer)
    }
    if (windows.size === 0) {
      for (const channel of channels) {
        ipcMain.removeHandler(channel)
      }
    }
  })
}
