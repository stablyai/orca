import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { WorkspaceViewCommand } from '../../shared/workspace-view-bridge'
import { isRetainedWorkspacePrimary } from './workspace-window-native-bridge'

export function registerWorkspaceViewTransferHistory(
  authorize: (event: IpcMainInvokeEvent) => BrowserWindow,
  windows: Map<number, BrowserWindow>,
  epochs: Map<number, number>,
  request: (
    window: BrowserWindow,
    operation: WorkspaceViewCommand,
    payload: unknown
  ) => Promise<unknown>
) {
  const transactions = new Map<
    string,
    {
      source: BrowserWindow
      destination: BrowserWindow
      sourceEpoch: number
      destinationEpoch: number
    }
  >()
  const pending = new Set<string>()
  ipcMain.handle('workspaceViews:undoTransfer', async (event, id: string) => {
    const invoker = authorize(event)
    const transaction = transactions.get(id)
    if (
      !transaction ||
      pending.has(id) ||
      (invoker !== transaction.source && invoker !== transaction.destination)
    ) {
      return false
    }
    const live = () =>
      [transaction.source, transaction.destination].every(
        (window, index) =>
          windows.get(window.id) === window &&
          !window.isDestroyed() &&
          !isRetainedWorkspacePrimary(window) &&
          (epochs.get(window.id) ?? 0) ===
            (index ? transaction.destinationEpoch : transaction.sourceEpoch)
      )
    if (!live()) {
      return false
    }
    pending.add(id)
    try {
      const ready = await Promise.all(
        [transaction.source, transaction.destination].map((window) =>
          request(window, 'prepare-undo-transfer', { id })
        )
      )
      if (ready.some((value) => value !== true) || !live()) {
        return false
      }
      if ((await request(transaction.source, 'undo-transfer', { id })) !== true || !live()) {
        return false
      }
      if ((await request(transaction.destination, 'undo-transfer', { id })) !== true || !live()) {
        return false
      }
      transactions.delete(id)
      return true
    } catch {
      return false
    } finally {
      pending.delete(id)
    }
  })
  return (id: string, source: BrowserWindow, destination: BrowserWindow): void => {
    transactions.set(id, {
      source,
      destination,
      sourceEpoch: epochs.get(source.id) ?? 0,
      destinationEpoch: epochs.get(destination.id) ?? 0
    })
    if (transactions.size > 40) {
      transactions.delete(transactions.keys().next().value!)
    }
  }
}
