import { ipcRenderer } from 'electron'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../shared/remote-pairing-verification'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'
import { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL } from '../../shared/runtime-environment-diagnostics'
import {
  subscribeRuntimeEnvironmentFromPreload,
  type RuntimeEnvironmentSubscriptionHandle
} from '../runtime-environment-subscriptions'
import type { PreloadApi } from '../api-types'

export const runtimeEnvironmentsApi = {
  list: (): Promise<PublicKnownRuntimeEnvironment[]> =>
    ipcRenderer.invoke('runtimeEnvironments:list'),
  addFromPairingCode: (args: {
    name: string
    pairingCode: string
  }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:addFromPairingCode', args),
  verifyAndAddFromPairingCode: (args: {
    name: string
    pairingCode: string
    allowLoopback?: boolean
  }): Promise<VerifyAndAddRuntimeEnvironmentResult> =>
    ipcRenderer.invoke('runtimeEnvironments:verifyAndAddFromPairingCode', args),
  resolve: (args: { selector: string }): Promise<PublicKnownRuntimeEnvironment> =>
    ipcRenderer.invoke('runtimeEnvironments:resolve', args),
  remove: (args: { selector: string }): Promise<{ removed: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:remove', args),
  disconnect: (args: {
    selector: string
  }): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:disconnect', args),
  connect: (args: {
    selector: string
    timeoutMs?: number
  }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
    ipcRenderer.invoke('runtimeEnvironments:connect', args),
  getStatus: (args: {
    selector: string
    timeoutMs?: number
    observeOnly?: true
  }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
    ipcRenderer.invoke('runtimeEnvironments:getStatus', args),
  retryControlConnection: (args: { selector: string }): Promise<void> =>
    ipcRenderer.invoke('runtimeEnvironments:retryControlConnection', args),
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
    ipcRenderer.on(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, listener)
  },
  prepareBrowserClientHostPlacement: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:prepareBrowserClientHostPlacement', args),
  retryConnectionsNow: (): Promise<void> =>
    ipcRenderer.invoke('runtimeEnvironments:retryConnectionsNow'),
  call: (args: {
    selector: string
    method: string
    params?: unknown
    timeoutMs?: number
    expectedEnvironmentPairingRevision?: number
  }): Promise<RuntimeRpcResponse<unknown>> => ipcRenderer.invoke('runtimeEnvironments:call', args),
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
    subscribeRuntimeEnvironmentFromPreload(ipcRenderer, args, callbacks)
} satisfies PreloadApi['runtimeEnvironments']
