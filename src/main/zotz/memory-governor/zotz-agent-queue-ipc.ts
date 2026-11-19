import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZotzAgentQueueSnapshot } from '../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { sendToTrustedUIRenderer } from '../../ipc/ui'
import type { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import type { ZotzMemoryGovernorService } from './zotz-memory-governor-service'

export function buildZotzAgentQueueSnapshot(
  governor: Pick<ZotzMemoryGovernorService, 'getState'>,
  queue: Pick<ZotzAgentLaunchQueue, 'list' | 'listCanceled'>
): ZotzAgentQueueSnapshot {
  const state = governor.getState()
  return {
    memory: state
      ? {
          totalBytes: state.totalBytes,
          availableBytes: state.availableBytes,
          pressure: state.pressure,
          minFreeBytes: state.limits.minFreeBytes,
          perAgentMaxBytes: state.limits.perAgentMaxBytes,
          sampledAt: state.sampledAt
        }
      : null,
    running:
      state?.agents.map(({ paneKey, agent, state, worktreeId, bytes, peakBytes, startedAt }) => ({
        paneKey,
        agent,
        state,
        worktreeId,
        bytes,
        peakBytes,
        startedAt
      })) ?? [],
    done: state?.finished ?? [],
    queued: queue.list().map((task) => ({
      id: task.id,
      agent: task.agent,
      priority: task.priority,
      label: task.label,
      estimatedBytes: task.estimatedBytes,
      enqueuedAt: task.enqueuedAt,
      position: task.position,
      waitReason: task.waitReason
    })),
    canceled: queue.listCanceled().map(({ id, agent, label, canceledAt }) => ({
      id,
      agent,
      label,
      canceledAt
    }))
  }
}

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
