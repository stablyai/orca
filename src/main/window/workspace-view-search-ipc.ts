import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type {
  WorkspaceViewCommand,
  WorkspaceViewLocation,
  WorkspaceViewPlacement
} from '../../shared/workspace-view-bridge'
import type { WorkspacePaneDropTarget } from '../../shared/window-pane-types'
import { isRetainedWorkspacePrimary } from './workspace-window-native-bridge'
import { safelyRevealWindow } from './focus-existing-window'

export function registerWorkspaceViewSearchIpc(
  authorize: (event: IpcMainInvokeEvent) => BrowserWindow,
  windows: Map<number, BrowserWindow>,
  epochs: Map<number, number>,
  request: (
    window: BrowserWindow,
    operation: WorkspaceViewCommand,
    payload: unknown
  ) => Promise<unknown>
): void {
  const live = (window: BrowserWindow, epoch: number): boolean =>
    windows.get(window.id) === window &&
    !window.isDestroyed() &&
    !isRetainedWorkspacePrimary(window) &&
    (epochs.get(window.id) ?? 0) === epoch
  ipcMain.handle('workspaceViews:discover', async (event) => {
    authorize(event)
    const results = await Promise.allSettled(
      [...windows.values()].map(async (window) => {
        const epoch = epochs.get(window.id) ?? 0
        if (!live(window, epoch)) {
          return []
        }
        const entries = (await request(window, 'discover', {})) as WorkspaceViewPlacement[]
        return live(window, epoch) && Array.isArray(entries)
          ? entries.map((entry) => ({
              ...entry,
              windowId: window.id,
              epoch,
              windowTitle: window.getTitle()
            }))
          : []
      })
    )
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  })
  ipcMain.handle('workspaceViews:visit', async (event, location: WorkspaceViewLocation) => {
    authorize(event)
    const window = windows.get(location.windowId)
    if (!window || !live(window, location.epoch)) {
      return false
    }
    const selected = await request(window, 'visit', location)
    if (selected !== true || !live(window, location.epoch)) {
      return false
    }
    safelyRevealWindow(window)
    return true
  })
  ipcMain.handle(
    'workspaceViews:open',
    async (event, location: WorkspaceViewLocation, target: WorkspacePaneDropTarget) => {
      const destination = authorize(event)
      const source = windows.get(location.windowId)
      const destinationEpoch = epochs.get(destination.id) ?? 0
      if (!source || !live(source, location.epoch) || !live(destination, destinationEpoch)) {
        return false
      }
      const id = randomUUID()
      let succeeded = false
      try {
        const packet = await request(source, 'capture', {
          id,
          paneId: location.paneId,
          viewIds: [location.viewId]
        })
        if (!live(source, location.epoch) || !live(destination, destinationEpoch)) {
          return false
        }
        await request(destination, 'import', { id, packet, mode: 'tabs', target })
        succeeded = live(destination, destinationEpoch)
        return succeeded
      } catch {
        if (live(destination, destinationEpoch)) {
          await request(destination, 'rollback', { id })
        }
        return false
      } finally {
        await Promise.allSettled(
          [source, destination]
            .filter((window) => live(window, window === source ? location.epoch : destinationEpoch))
            .map((window) => request(window, 'finish', { id, succeeded }))
        )
      }
    }
  )
}
