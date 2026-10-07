import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { PtyRendererDelivery } from '../session'

export function isMainWindowPtyIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined
): boolean {
  const mainWebContents = mainWindow?.webContents
  return (
    !!mainWindow &&
    !!mainWebContents &&
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())
  )
}
