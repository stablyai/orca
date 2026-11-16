import type {
  RendererStatusPublication,
  RendererStatusAck
} from '../../../shared/agent-status/renderer-status-publication'
import { ipcRenderer } from 'electron'
import type { ClientHostedBrowserRowsEvent } from '../../../shared/browser/client-hosting/client-hosted-browser-rows'
import type { SidebarInputsChangedEvent } from '../../../shared/sidebar-list/feed/sidebar-inputs-feed-contract'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeEnvironmentSubscriptionHandle } from '../../runtime/runtime-environment-subscriptions'
import type { PreloadApi } from '../../api-types'
import {
  RUNTIME_ACKED_SUBSCRIPTION_METHODS,
  RUNTIME_SUBSCRIPTION_ACK_CHANNEL,
  RUNTIME_SUBSCRIPTION_ACK_DELAY_MS,
  RUNTIME_SUBSCRIPTION_ACK_EVERY_FRAMES,
  type RuntimeSubscriptionAck
} from '../../../shared/remote-runtime/rpc/runtime-subscription-ack'

/** Acks frames once handled, so main releases what it holds for them. */
function subscriptionAcks(subscriptionId: string) {
  let processed = 0
  let acked = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = (): void => {
    timer = undefined
    if (processed > acked) {
      acked = processed
      ipcRenderer.send(RUNTIME_SUBSCRIPTION_ACK_CHANNEL, {
        subscriptionId,
        processedFrames: processed
      } satisfies RuntimeSubscriptionAck)
    }
  }
  return {
    processed: (): void => {
      processed += 1
      if (processed - acked >= RUNTIME_SUBSCRIPTION_ACK_EVERY_FRAMES) {
        clearTimeout(timer)
        send()
      } else {
        timer ??= setTimeout(send, RUNTIME_SUBSCRIPTION_ACK_DELAY_MS)
      }
    },
    stop: (): void => clearTimeout(timer)
  }
}

export const runtimeApi = {
  syncAgentStatus: (batch: RendererStatusPublication): Promise<RendererStatusAck> =>
    ipcRenderer.invoke('runtime:syncAgentStatus', batch),
  syncWindowGraph: (graph: RuntimeRendererSyncWindowGraph): Promise<RuntimeSyncWindowGraphResult> =>
    ipcRenderer.invoke('runtime:syncWindowGraph', graph),
  getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus'),
  call: (args: {
    method: string
    params?: unknown
    orchestration?: { contractVersion: number; requestId: string }
  }): Promise<RuntimeRpcResponse<unknown>> => ipcRenderer.invoke('runtime:call', args),
  subscribe: async (
    args: { method: string; params?: unknown },
    callback: (response: RuntimeRpcResponse<unknown>) => void
  ): Promise<RuntimeEnvironmentSubscriptionHandle> => {
    const subscriptionId = `desktop-${crypto.randomUUID()}`
    const channel = `runtime:subscription:${subscriptionId}`
    const acks = RUNTIME_ACKED_SUBSCRIPTION_METHODS.has(args.method)
      ? subscriptionAcks(subscriptionId)
      : undefined
    const listener = (_event: Electron.IpcRendererEvent, response: RuntimeRpcResponse<unknown>) => {
      try {
        callback(response)
      } finally {
        acks?.processed()
      }
    }
    ipcRenderer.on(channel, listener)
    try {
      await ipcRenderer.invoke('runtime:subscribe', { subscriptionId, ...args })
    } catch (error) {
      ipcRenderer.removeListener(channel, listener)
      acks?.stop()
      throw error
    }
    return {
      unsubscribe: () => {
        ipcRenderer.removeListener(channel, listener)
        acks?.stop()
        ipcRenderer.send('runtime:unsubscribe', { subscriptionId })
      },
      sendBinary: () => {
        throw new Error('Local runtime subscriptions do not accept binary input')
      }
    }
  },
  getTerminalFitOverrides: (): Promise<
    { ptyId: string; mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }[]
  > => ipcRenderer.invoke('runtime:getTerminalFitOverrides'),
  getTerminalDrivers: (): Promise<
    {
      ptyId: string
      driver: RuntimeTerminalDriverState
    }[]
  > => ipcRenderer.invoke('runtime:getTerminalDrivers'),
  getBrowserDrivers: (): Promise<
    {
      browserPageId: string
      driver: RuntimeTerminalDriverState
    }[]
  > => ipcRenderer.invoke('runtime:getBrowserDrivers'),
  getBrowserRemoteViewerPages: (): Promise<string[]> =>
    ipcRenderer.invoke('runtime:getBrowserRemoteViewerPages'),
  getClientHostedBrowserRows: (): Promise<ClientHostedBrowserRowsEvent[]> =>
    ipcRenderer.invoke('runtime:getClientHostedBrowserRows'),
  restoreTerminalFit: (ptyId: string): Promise<{ restored: boolean }> =>
    ipcRenderer.invoke('runtime:restoreTerminalFit', { ptyId }),
  reclaimBrowserForDesktop: (browserPageId: string): Promise<{ reclaimed: boolean }> =>
    ipcRenderer.invoke('runtime:reclaimBrowserForDesktop', { browserPageId }),
  onTerminalFitOverrideChanged: (
    callback: (event: {
      ptyId: string
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }
    ) => callback(data)
    ipcRenderer.on('runtime:terminalFitOverrideChanged', listener)
    return () => ipcRenderer.removeListener('runtime:terminalFitOverrideChanged', listener)
  },
  onTerminalDriverChanged: (
    callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }
    ) => callback(data)
    ipcRenderer.on('runtime:terminalDriverChanged', listener)
    return () => ipcRenderer.removeListener('runtime:terminalDriverChanged', listener)
  },
  onNativeChatLaunchDraftResolved: (
    callback: (event: { tabId: string; text: string; createdAt: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; text: string; createdAt: number }
    ) => callback(data)
    ipcRenderer.on('runtime:nativeChatLaunchDraftResolved', listener)
    return () => ipcRenderer.removeListener('runtime:nativeChatLaunchDraftResolved', listener)
  },
  onBrowserDriverChanged: (
    callback: (event: { browserPageId: string; driver: RuntimeTerminalDriverState }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        driver: RuntimeTerminalDriverState
      }
    ) => callback(data)
    ipcRenderer.on('runtime:browserDriverChanged', listener)
    return () => ipcRenderer.removeListener('runtime:browserDriverChanged', listener)
  },
  onBrowserRemoteViewersChanged: (
    callback: (event: { browserPageId: string; hasRemoteViewers: boolean }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        hasRemoteViewers: boolean
      }
    ) => callback(data)
    ipcRenderer.on('runtime:browserRemoteViewersChanged', listener)
    return () => ipcRenderer.removeListener('runtime:browserRemoteViewersChanged', listener)
  },
  onClientHostedBrowserRowsChanged: (
    callback: (event: ClientHostedBrowserRowsEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ClientHostedBrowserRowsEvent) =>
      callback(data)
    ipcRenderer.on('runtime:clientHostedBrowserRowsChanged', listener)
    return () => ipcRenderer.removeListener('runtime:clientHostedBrowserRowsChanged', listener)
  },
  onSidebarInputsChanged: (callback: (event: SidebarInputsChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SidebarInputsChangedEvent) =>
      callback(data)
    ipcRenderer.on('runtime:sidebarInputsChanged', listener)
    return () => ipcRenderer.removeListener('runtime:sidebarInputsChanged', listener)
  },
  onOrchestrationSessionWorkersChanged: (
    callback: (event: { sessionId: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) =>
      callback(data)
    ipcRenderer.on('runtime:orchestrationSessionWorkersChanged', listener)
    return () => ipcRenderer.removeListener('runtime:orchestrationSessionWorkersChanged', listener)
  }
} satisfies PreloadApi['runtime']
