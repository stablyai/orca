import type { IpcRenderer } from 'electron'
import type { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL as DiagnosticsChannel } from '../../shared/runtime-environment-diagnostics'
const { ipcRenderer } = require('electron') as { ipcRenderer: IpcRenderer }
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../shared/remote-pairing-verification'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'
import {
  subscribeRuntimeEnvironmentFromPreload,
  type RuntimeEnvironmentSubscriptionHandle
} from '../runtime-environment-subscriptions'
import type { PreloadApi } from '../api-types'

// Sandboxed preloads cannot require the main bundle's shared chunks.
const RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL =
  'runtimeEnvironments:sharedControlDiagnostics' satisfies typeof DiagnosticsChannel

export function createRuntimeEnvironmentsBridge(
  ipc: Pick<typeof ipcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'> = ipcRenderer
) {
  return {
    list: (): Promise<PublicKnownRuntimeEnvironment[]> => ipc.invoke('runtimeEnvironments:list'),
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
      ipc.invoke('runtimeEnvironments:addFromPairingCode', args),
    verifyAndAddFromPairingCode: (args: {
      name: string
      pairingCode: string
      allowLoopback?: boolean
    }): Promise<VerifyAndAddRuntimeEnvironmentResult> =>
      ipc.invoke('runtimeEnvironments:verifyAndAddFromPairingCode', args),
    resolve: (args: { selector: string }): Promise<PublicKnownRuntimeEnvironment> =>
      ipc.invoke('runtimeEnvironments:resolve', args),
    remove: (args: { selector: string }): Promise<{ removed: PublicKnownRuntimeEnvironment }> =>
      ipc.invoke('runtimeEnvironments:remove', args),
    disconnect: (args: {
      selector: string
    }): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> =>
      ipc.invoke('runtimeEnvironments:disconnect', args),
    connect: (args: {
      selector: string
      timeoutMs?: number
    }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
      ipc.invoke('runtimeEnvironments:connect', args),
    getStatus: (args: {
      selector: string
      timeoutMs?: number
      observeOnly?: true
    }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
      ipc.invoke('runtimeEnvironments:getStatus', args),
    retryControlConnection: (args: { selector: string }): Promise<void> =>
      ipc.invoke('runtimeEnvironments:retryControlConnection', args),
    onSharedControlDiagnostics: (
      callback: (event: {
        environmentId: string
        transportGeneration: number
        diagnostics: RemoteRuntimeSharedConnectionDiagnostics
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          environmentId: string
          transportGeneration: number
          diagnostics: RemoteRuntimeSharedConnectionDiagnostics
        }
      ): void => callback(data)
      ipc.on(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, listener)
      return () => ipc.removeListener(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, listener)
    },
    prepareBrowserClientHostPlacement: (args) =>
      ipc.invoke('runtimeEnvironments:prepareBrowserClientHostPlacement', args),
    retryConnectionsNow: (): Promise<void> => ipc.invoke('runtimeEnvironments:retryConnectionsNow'),
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
      expectedEnvironmentPairingRevision?: number
    }): Promise<RuntimeRpcResponse<unknown>> => ipc.invoke('runtimeEnvironments:call', args),
    subscribe: async (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ): Promise<RuntimeEnvironmentSubscriptionHandle> =>
      subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks)
  } satisfies PreloadApi['runtimeEnvironments']
}

export const runtimeEnvironmentsApi = createRuntimeEnvironmentsBridge()
