import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { sendToTrustedUIRenderer } from '../../ipc/ui'
import type { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import { buildZotzAgentQueueSnapshot } from './zotz-agent-queue-snapshot-builder'
import type { ZotzMemoryGovernorService } from './zotz-memory-governor-service'

// Only the app's own windows may start or cancel agent launches.
function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}

function taskId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null
}

export function registerZotzAgentQueueHandlers(
  governor: ZotzMemoryGovernorService,
  queue: ZotzAgentLaunchQueue
): () => void {
  const publish = (): void =>
    sendToTrustedUIRenderer('zotzAgentQueue:changed', buildZotzAgentQueueSnapshot(governor, queue))
  ipcMain.handle('zotzAgentQueue:snapshot', () => {
    // A window opening the board wants current numbers even on an idle node.
    governor.wake()
    return buildZotzAgentQueueSnapshot(governor, queue)
  })
  ipcMain.handle('zotzAgentQueue:forceStart', (event, id: unknown) => {
    const valid = taskId(id)
    if (isWindowRenderer(event) && valid) {
      queue.forceStart(valid)
    }
  })
  ipcMain.handle('zotzAgentQueue:cancel', (event, id: unknown) => {
    const valid = taskId(id)
    if (isWindowRenderer(event) && valid) {
      queue.cancel(valid)
    }
  })
  ipcMain.handle('zotzAgentQueue:dismissCanceled', (event, id: unknown) => {
    const valid = taskId(id)
    if (isWindowRenderer(event) && valid) {
      queue.dismissCanceled(valid)
    }
  })
  const unsubscribeQueue = queue.subscribe(publish)
  const unsubscribeGovernor = governor.subscribe(publish)
  return () => {
    unsubscribeQueue()
    unsubscribeGovernor()
    ipcMain.removeHandler('zotzAgentQueue:snapshot')
    ipcMain.removeHandler('zotzAgentQueue:forceStart')
    ipcMain.removeHandler('zotzAgentQueue:cancel')
    ipcMain.removeHandler('zotzAgentQueue:dismissCanceled')
  }
}
