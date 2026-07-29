import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { filterExistingFiles, type OsFileOpenRequestQueue } from '../startup/os-file-open-requests'

export function registerOsFileOpenHandlers(queue: OsFileOpenRequestQueue): void {
  // Why: per-registration state — WebContents survives reloads (dedupes 'destroyed' listeners),
  // and the single deliver slot must stay with whoever last took it (a stale sender's teardown must not clobber a newer owner).
  const boundSenders = new WeakSet<WebContents>()
  let currentOwner: WebContents | null = null

  ipcMain.handle('osFileOpen:takePending', async (event): Promise<string[]> => {
    const sender = event.sender as WebContents
    currentOwner = sender
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
        if (currentOwner === sender) {
          currentOwner = null
          queue.setDeliver(null)
        }
      }
      sender.once('destroyed', cleanup)
    }
    return filterExistingFiles(queue.drain())
  })
}
