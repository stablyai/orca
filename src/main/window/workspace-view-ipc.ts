import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  authorizeWorkspaceWindowEvent,
  isRetainedWorkspacePrimary
} from './workspace-window-native-bridge'
import { WorkspaceViewControlPublication } from './workspace-view-control-publication'
import { WorkspaceViewRelay } from './workspace-view-relay'
import { WorkspaceViewTransfer } from '../../shared/workspace-view-transfer'
import {
  WorkspaceViewControl,
  type WorkspaceViewRegistration
} from '../../shared/workspace-view-control'
import type { WorkspaceViewBridge, WorkspaceViewCommand } from '../../shared/workspace-view-bridge'
import { isBackgroundLaunch } from './foreground-activation-policy'
import { registerWorkspaceViewSearchIpc } from './workspace-view-search-ipc'
import { registerWorkspaceWindowMonitors } from './workspace-window-monitors'
import { registerWorkspaceViewTransferHistory } from './workspace-view-transfer-history'

export function registerWorkspaceViewIpc(
  getPrimary: () => BrowserWindow | null,
  createWindow?: (reopen?: boolean) => BrowserWindow
): void {
  const relay = new WorkspaceViewRelay()
  const transfers = new WorkspaceViewTransfer()
  const windows = new Map<number, BrowserWindow>()
  const readyWaiters = new Map<number, () => void>()
  const offeredViews = new Map<number, WorkspaceViewRegistration[]>()
  const tracked = new WeakSet<BrowserWindow>()
  const epochs = new Map<number, number>()
  const control = new WorkspaceViewControl()
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
    const primary = getPrimary()
    if (
      primary &&
      event.sender === primary.webContents &&
      event.senderFrame === event.sender.mainFrame
    ) {
      return primary
    }
    return authorizeWorkspaceWindowEvent(event)
  }
  const openWindow = async (event: IpcMainInvokeEvent, reopen = false): Promise<number> => {
    authorize(event)
    if (!createWindow) {
      throw new Error('Native window creation unavailable')
    }
    const destination = createWindow(reopen)
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        readyWaiters.delete(destination.id)
        destination.removeListener('closed', closed)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const closed = (): void => finish(new Error('Destination window closed'))
      const timer = setTimeout(
        () => finish(new Error('Destination window did not become ready')),
        30_000
      )
      readyWaiters.set(destination.id, () => finish())
      destination.once('closed', closed)
    })
    return destination.id
  }
  ipcMain.handle('workspaceViews:createWindow', (event) => openWindow(event))
  ipcMain.handle('workspaceViews:reopenWindow', (event) => openWindow(event, true))
  const request = async (
    window: BrowserWindow,
    operation: WorkspaceViewCommand,
    payload: unknown
  ): Promise<unknown> => {
    const response = (await relay.request(
      window.webContents.id,
      (id, command, data) => {
        window.webContents.send('workspaceViews:request', id, command, data)
      },
      operation,
      payload
    )) as { ok: boolean; value?: unknown; error?: string }
    if (!response.ok) {
      throw new Error(response.error ?? 'View transfer failed')
    }
    return response.value
  }
  registerWorkspaceViewSearchIpc(authorize, windows, epochs, request)
  registerWorkspaceWindowMonitors(authorize, windows)
  const rememberTransfer = registerWorkspaceViewTransferHistory(authorize, windows, epochs, request)
  let controlQueue = Promise.resolve()
  ipcMain.handle('workspaceViews:locateDrop', async (event, point: { x: number; y: number }) => {
    const source = authorize(event)
    const origin = source.getContentBounds()
    const sourceZoom = source.webContents.getZoomFactor()
    const screenPoint = { x: origin.x + point.x * sourceZoom, y: origin.y + point.y * sourceZoom }
    for (const destination of [...windows.values()].toReversed()) {
      if (
        source === destination ||
        destination.isDestroyed() ||
        destination.isMinimized() ||
        (!isBackgroundLaunch() && !destination.isVisible()) ||
        isRetainedWorkspacePrimary(destination)
      ) {
        continue
      }
      const bounds = destination.getContentBounds()
      if (
        screenPoint.x < bounds.x ||
        screenPoint.x > bounds.x + bounds.width ||
        screenPoint.y < bounds.y ||
        screenPoint.y > bounds.y + bounds.height
      ) {
        continue
      }
      const destinationZoom = destination.webContents.getZoomFactor()
      const target = await request(destination, 'drop-target', {
        x: (screenPoint.x - bounds.x) / destinationZoom,
        y: (screenPoint.y - bounds.y) / destinationZoom
      })
      return target
        ? { ...(target as object), destinationId: destination.id, title: destination.getTitle() }
        : null
    }
    return null
  })
  const publication = new WorkspaceViewControlPublication()
  const publishControls = (): Promise<void> => {
    const snapshot = control.snapshot()
    controlQueue = controlQueue
      .catch(() => {})
      .then(async () => {
        await publication.publish(snapshot, new Set(windows.keys()), async (id, next) => {
          const window = windows.get(id)
          if (window && !window.isDestroyed()) {
            await request(window, 'controllers', next)
          }
        })
      })
    return controlQueue
  }
  ipcMain.handle('workspaceViews:register', async (event, views: WorkspaceViewRegistration[]) => {
    const window = authorize(event)
    offeredViews.set(window.id, views)
    control.register(window.id, isRetainedWorkspacePrimary(window) ? [] : views)
    await publishControls()
  })
  ipcMain.handle('workspaceViews:claim', async (event, key: string, viewId: string) => {
    const window = authorize(event)
    if (isRetainedWorkspacePrimary(window) || !control.claim(window.id, key, viewId)) {
      return false
    }
    await publishControls()
    return true
  })
  ipcMain.handle('workspaceViews:ready', (event) => {
    const window = authorize(event)
    windows.set(window.id, window)
    readyWaiters.get(window.id)?.()
    if (!tracked.has(window)) {
      tracked.add(window)
      window.on('focus', () => {
        if (windows.has(window.id)) {
          windows.delete(window.id)
          windows.set(window.id, window)
        }
      })
      const webContentsId = window.webContents.id
      const disconnect = (): void => {
        windows.delete(window.id)
        offeredViews.delete(window.id)
        epochs.set(window.id, (epochs.get(window.id) ?? 0) + 1)
        relay.disconnect(webContentsId)
        control.register(window.id, [])
        void publishControls().catch(() => {})
      }
      window.webContents.once('destroyed', disconnect)
      window.webContents.on('render-process-gone', disconnect)
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          disconnect()
        }
      })
      ;(window as EventEmitter).on('workspace-presentation-retained', () => {
        control.register(window.id, [])
        void publishControls().catch(() => {})
      })
      window.on('show', () => {
        control.register(window.id, offeredViews.get(window.id) ?? [])
        void publishControls()
      })
    }
    return window.id
  })
  ipcMain.handle('workspaceViews:list', (event) => {
    authorize(event)
    return [...windows.values()]
      .filter((window) => !window.isDestroyed() && !isRetainedWorkspacePrimary(window))
      .map((window) => ({ id: window.id, title: window.getTitle() }))
  })
  ipcMain.handle('workspaceViews:reply', (event, id: string, result: unknown) => {
    authorize(event)
    return relay.reply(event.sender.id, id, result)
  })
  ipcMain.handle(
    'workspaceViews:transfer',
    async (event, args: Parameters<WorkspaceViewBridge['transfer']>[0]) => {
      const source = authorize(event)
      const destination = windows.get(args.destinationId)
      if (
        !destination ||
        isRetainedWorkspacePrimary(destination) ||
        source === destination ||
        !['tabs', 'panes'].includes(args.mode)
      ) {
        return false
      }
      const id = randomUUID()
      const destinationEpoch = epochs.get(destination.id)
      const destinationLive = (): boolean =>
        !destination.isDestroyed() &&
        windows.has(destination.id) &&
        epochs.get(destination.id) === destinationEpoch &&
        !isRetainedWorkspacePrimary(destination)
      const packet = await request(source, 'capture', { id, viewIds: args.viewIds })
      const succeeded = await transfers.run(id, {
        import: async () => {
          if (!destinationLive()) {
            throw new Error('Destination window closed')
          }
          await request(destination, 'import', {
            id,
            packet,
            mode: args.mode,
            ...(args.target ? { target: args.target } : {})
          })
        },
        isDestinationLive: destinationLive,
        remove: async () => {
          if (args.duplicate === true) {
            return true
          }
          try {
            const removed = (await request(source, 'remove', { id })) === true
            if (!destinationLive()) {
              await request(source, 'restore', { id })
              return false
            }
            return removed
          } catch (error) {
            if (!source.isDestroyed()) {
              await request(source, 'restore', { id })
            }
            throw error
          }
        },
        rollback: async () => {
          if (!destination.isDestroyed()) {
            await request(destination, 'rollback', { id })
          }
        }
      })
      if (succeeded && !args.duplicate) {
        rememberTransfer(id, source, destination)
      }
      await Promise.allSettled(
        [source, destination]
          .filter((window) => !window.isDestroyed())
          .map((window) =>
            request(window, 'finish', { id, succeeded, transaction: !args.duplicate })
          )
      )
      return succeeded
    }
  )
}
