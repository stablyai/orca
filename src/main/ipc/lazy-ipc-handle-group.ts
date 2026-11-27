import { ipcMain, type IpcMainInvokeEvent } from 'electron'

export type IpcHandleListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

export type IpcHandleRegistrar = {
  handle(channel: string, listener: IpcHandleListener): void
}

/**
 * Registers IPC channels immediately while deferring dynamic module import until first invoke.
 * Eliminates startup parse/eval cost for rarely-used subsystems without any removeHandler race window.
 */
export function registerLazyIpcHandleGroup(
  channels: readonly string[],
  load: (ipc: IpcHandleRegistrar) => Promise<void>
): void {
  let loadedHandlers: Map<string, IpcHandleListener> | null = null
  let loadingPromise: Promise<Map<string, IpcHandleListener>> | null = null

  const ensureLoaded = (): Promise<Map<string, IpcHandleListener>> => {
    if (loadedHandlers) {
      return Promise.resolve(loadedHandlers)
    }
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const handlers = new Map<string, IpcHandleListener>()
        await load({
          handle: (channel, listener) => {
            handlers.set(channel, listener)
          }
        })
        loadedHandlers = handlers
        return handlers
      })().catch((error: unknown) => {
        loadingPromise = null
        throw error
      })
    }
    return loadingPromise
  }

  for (const channel of channels) {
    ipcMain.handle(channel, (event, ...args) => {
      if (loadedHandlers) {
        const fn = loadedHandlers.get(channel)
        if (!fn) {
          throw new Error(`No lazy IPC handler registered for ${channel}`)
        }
        return fn(event, ...args)
      }
      return ensureLoaded().then((handlers) => {
        const fn = handlers.get(channel)
        if (!fn) {
          throw new Error(`No lazy IPC handler registered for ${channel}`)
        }
        return fn(event, ...args)
      })
    })
  }
}
