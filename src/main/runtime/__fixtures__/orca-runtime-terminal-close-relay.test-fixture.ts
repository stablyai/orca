import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { ipcMain } from 'electron'
import { testState } from '../../persistence/persistence-test-harness'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { Store } from '../../persistence/loading-store/store'

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]
type IpcListener = Parameters<typeof ipcMain.on>[1]

const closeIpc = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  listeners: new Map<string, Set<IpcListener>>()
}))
export { closeIpc }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString()
  },
  ipcMain: {
    handle: (name: string, callback: InvokeHandler) => closeIpc.handlers.set(name, callback),
    on: (name: string, callback: IpcListener) => {
      const listeners = closeIpc.listeners.get(name) ?? new Set()
      listeners.add(callback)
      closeIpc.listeners.set(name, listeners)
    },
    removeListener: (name: string, callback: IpcListener) =>
      closeIpc.listeners.get(name)?.delete(callback)
  }
}))

export async function installAcknowledgedCloseRelay(
  store: Store,
  runtime: OrcaRuntimeService,
  onAck: () => void = () => {}
) {
  const { registerSessionHandlers } = await import('../../ipc/session')
  const { requestTerminalTabCloseFromRenderer } =
    await import('../../window/terminal-tab-close-request-relay')
  const { setRuntimeDesktopSurface } = await import('../runtime-desktop-surface')
  const { registerMobileAndTerminalCloseIpcBridge } =
    await import('../../../renderer/src/hooks/ipc-events/mobile-terminal-close-ipc-bridge')
  const unsubs: (() => void)[] = []
  type Request = Parameters<Parameters<typeof window.api.ui.onTerminalTabCloseRequest>[0]>[0]
  let requestConsumer: ((request: Request) => void) | undefined
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    setBackgroundThrottling: () => {},
    send: (channel: string, request: Request) => {
      if (channel !== 'ui:terminalTabCloseRequest' || !requestConsumer) {
        throw new Error('close request consumer missing')
      }
      queueMicrotask(() => requestConsumer?.(request))
    }
  })
  const win = { isDestroyed: () => false, webContents }
  registerSessionHandlers(store, runtime)
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = closeIpc.handlers.get(channel)
    if (!handler) {
      throw new Error('session handler missing')
    }
    return handler({ sender: webContents } as never, ...args)
  }
  Object.assign(window.api, {
    session: {
      set: (value: WorkspaceSessionState, hostId?: string | null) =>
        invoke('session:set', value, hostId),
      patch: (value: unknown, hostId?: string | null) => invoke('session:patch', value, hostId),
      get: (hostId?: string | null) => invoke('session:get', hostId),
      flush: () => invoke('session:flush'),
      closeTerminalSurface: (args: unknown) => invoke('session:close-terminal-surface', args)
    }
  })
  Object.assign(window.api.ui, {
    onOpenFileFromMobile: () => () => {},
    onOpenDiffFromMobile: () => () => {},
    onCloseTerminal: () => () => {},
    onWorkspaceSleep: () => () => {},
    onResumeSleepingAgents: () => () => {},
    onTerminalTabCloseRequest: (listener: typeof requestConsumer) => {
      requestConsumer = listener
      return () => {
        requestConsumer = undefined
      }
    },
    respondTerminalTabClose: (response: { requestId: string; error?: string }) => {
      queueMicrotask(() => {
        const listeners = closeIpc.listeners.get('ui:terminalTabCloseResponse') ?? []
        for (const listener of listeners) {
          listener({ sender: {} } as never, { ...response, error: 'wrong-sender' })
          listener({ sender: webContents } as never, {
            ...response,
            requestId: 'other-request',
            error: 'wrong-request'
          })
        }
        onAck()
        for (const listener of listeners) {
          listener({ sender: webContents } as never, response)
        }
      })
    }
  })
  registerMobileAndTerminalCloseIpcBridge(unsubs, () => {})
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => win as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  return {
    sender: webContents,
    invoke,
    closeTerminalTab: (
      tabId: string,
      options: Parameters<typeof requestTerminalTabCloseFromRenderer>[2]
    ) => requestTerminalTabCloseFromRenderer(win as never, tabId, options),
    dispose: () => {
      for (const unsubscribe of unsubs) {
        unsubscribe()
      }
      closeIpc.handlers.clear()
      closeIpc.listeners.clear()
    }
  }
}
