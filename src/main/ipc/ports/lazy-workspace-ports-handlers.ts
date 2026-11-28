import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from '../../ports/advertised-url-watcher'
import type { WorkspacePortAdvertisedUrlChangedEvent } from '../../../shared/workspace/ports/workspace-ports'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const WORKSPACE_PORT_IPC_CHANNELS = [
  'workspacePorts:scan',
  'workspacePorts:kill',
  'workspacePorts:probePage'
] as const

type WorkspacePortHandlersOptions = {
  advertisedUrlEvents?: Pick<AdvertisedUrlWatcher, 'onDidChange'>
  getWindows?: () => BrowserWindow[]
}

let unsubscribeAdvertisedUrlChanges: (() => void) | null = null

export function registerLazyWorkspacePortHandlers(
  store: Store,
  options: WorkspacePortHandlersOptions = {}
): void {
  const advertisedUrlEvents = options.advertisedUrlEvents ?? advertisedUrlWatcher
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows())

  unsubscribeAdvertisedUrlChanges?.()
  unsubscribeAdvertisedUrlChanges = advertisedUrlEvents.onDidChange((event) => {
    void import('../../ports/workspace-port-ownership')
      .then(({ getStoreWorkspacePortProbes }) => {
        const localWorktrees = getStoreWorkspacePortProbes(store)
        if (!localWorktrees.some((worktree) => worktree.id === event.worktreeId)) {
          return
        }
        broadcastWorkspacePortAdvertisedUrlChanged(getWindows, event)
      })
      .catch(() => undefined)
  })

  for (const channel of WORKSPACE_PORT_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(WORKSPACE_PORT_IPC_CHANNELS, async (ipc) => {
    const { registerWorkspacePortIpcHandlers } = await import('./workspace-ports')
    registerWorkspacePortIpcHandlers(store, ipc)
  })
}

function broadcastWorkspacePortAdvertisedUrlChanged(
  getWindows: () => BrowserWindow[],
  event: WorkspacePortAdvertisedUrlChangedEvent
): void {
  for (const window of getWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    const webContents = window.webContents
    if (webContents.isDestroyed()) {
      continue
    }
    webContents.send('workspacePorts:advertised-url-changed', event)
  }
}
