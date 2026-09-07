import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { resolveWorkspaceWindowBrowserTarget } from './workspace-window-browser-target'
import {
  dispatchWorkspaceWindowBrowserInput,
  WORKSPACE_WINDOW_BROWSER_INPUT_METHODS
} from './workspace-window-browser-input'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { Screencast } from '../runtime/rpc/methods/browser-schemas'
import { authorizeWorkspaceWindowEvent } from './workspace-window-native-bridge'
import {
  captureWorkspaceWindowBrowserOwner,
  type WorkspaceWindowBrowserOwner
} from './workspace-window-browser-owner'

export function registerWorkspaceWindowBrowserStream(
  getRuntime: () => OrcaRuntimeService | null,
  getPrimary: () => BrowserWindow | null = () => null
): void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (
      getPrimary()?.webContents === event.sender &&
      event.senderFrame === event.sender.mainFrame
    ) {
      return
    }
    authorizeWorkspaceWindowEvent(event)
  }
  const streams = new Map<string, AbortController>()
  ipcMain.handle(
    'workspaceWindow:browserInput',
    async (event, request: WorkspaceWindowBrowserOwner & { method: string; params: unknown }) => {
      authorize(event)
      const runtime = getRuntime()
      if (!runtime || !WORKSPACE_WINDOW_BROWSER_INPUT_METHODS.has(request.method)) {
        return null
      }
      const ownerIsCurrent = captureWorkspaceWindowBrowserOwner(request, runtime.getRuntimeId())
      if (!ownerIsCurrent?.()) {
        return null
      }
      const target = resolveWorkspaceWindowBrowserTarget(
        request.runtimeId,
        runtime.getRuntimeId(),
        Screencast.parse(request.params)
      )
      if (!target) {
        return null
      }
      const result = await dispatchWorkspaceWindowBrowserInput(
        event.sender,
        target.webContents,
        request.method,
        request.params
      )
      return { id: 'native-browser-input', ok: true, result }
    }
  )
  ipcMain.handle(
    'workspaceWindow:browserStream:start',
    (event, id: string, request: WorkspaceWindowBrowserOwner & { params: unknown }) => {
      authorize(event)
      const params = Screencast.parse(request.params)
      const runtime = getRuntime()
      if (!runtime || !request.runtimeId) {
        return false
      }
      const ownerIsCurrent = captureWorkspaceWindowBrowserOwner(request, runtime.getRuntimeId())
      if (!ownerIsCurrent?.()) {
        return false
      }
      const target = resolveWorkspaceWindowBrowserTarget(
        request.runtimeId,
        runtime.getRuntimeId(),
        params
      )
      if (!target) {
        return false
      }
      const key = `${event.sender.id}:${id}`
      streams.get(key)?.abort()
      const controller = new AbortController()
      streams.set(key, controller)
      const stop = (): void => controller.abort()
      const navigate = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame && !isInPlace) {
          stop()
        }
      }
      event.sender.once('destroyed', stop)
      event.sender.on('did-start-navigation', navigate)
      const send = (kind: string, data?: unknown): void => {
        if (!controller.signal.aborted && !ownerIsCurrent()) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('workspaceWindow:browserStream:event', { id, kind: 'close' })
          }
          stop()
        }
        if (!controller.signal.aborted && !event.sender.isDestroyed()) {
          event.sender.send('workspaceWindow:browserStream:event', { id, kind, data })
        }
      }
      void runtime
        .browserScreencast(params, {
          connectionId: `workspace-window:${key}`,
          clientKind: 'runtime',
          localWindowTarget: target,
          signal: controller.signal,
          sendBinary: (bytes) => {
            send('binary', bytes)
            return !controller.signal.aborted
          },
          emit: (result) => send('response', { id, ok: true, result })
        })
        .catch((error: unknown) => {
          send('error', {
            code: 'browser_error',
            message: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => {
          send('close')
          event.sender.removeListener('destroyed', stop)
          event.sender.removeListener('did-start-navigation', navigate)
          if (streams.get(key) === controller) {
            streams.delete(key)
          }
        })
      return true
    }
  )
  ipcMain.handle('workspaceWindow:browserStream:stop', (event, id: string) => {
    authorize(event)
    streams.get(`${event.sender.id}:${id}`)?.abort()
  })
}
