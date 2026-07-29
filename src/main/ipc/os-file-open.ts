import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { filterExistingFiles, type OsFileOpenRequestQueue } from '../startup/os-file-open-requests'

// Why: WebContents survives renderer reloads, so track per-sender binding to avoid stacking 'destroyed' listeners.
const boundSenders = new WeakSet<WebContents>()

export function registerOsFileOpenHandlers(queue: OsFileOpenRequestQueue): void {
  ipcMain.handle('osFileOpen:takePending', async (event): Promise<string[]> => {
    const sender = event.sender as WebContents
    // Why: taking the batch is the renderer's readiness signal, so later arrivals push instead of buffering.
    queue.setDeliver((filePath) => {
      if (!sender.isDestroyed()) {
        sender.send('osFileOpen:opened', filePath)
      }
    })
    if (!boundSenders.has(sender)) {
      boundSenders.add(sender)
      const cleanup = (): void => {
        boundSenders.delete(sender)
        sender.removeListener('destroyed', cleanup)
        queue.setDeliver(null)
      }
      sender.once('destroyed', cleanup)
    }
    return filterExistingFiles(queue.drain())
  })
}
