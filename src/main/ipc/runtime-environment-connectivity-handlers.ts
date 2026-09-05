import { ipcMain } from 'electron'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { Store } from '../persistence'
import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-retirement'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { clearRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import {
  closeRemoteRuntimeRequestConnection,
  retryRemoteRuntimeSharedControlConnectionNow
} from './runtime-environment-request-connections'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected,
  markRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus
} from './runtime-environment-transport-routing'

function manuallyDisconnectedResponse(
  environment: ReturnType<typeof resolveEnvironment>
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: 'Runtime environment is manually disconnected.'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export { isRuntimeEnvironmentManuallyDisconnected }

type ConnectivityHandlerOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

export function registerRuntimeEnvironmentConnectivityHandlers({
  store,
  getUserDataPath,
  invalidateTransport
}: ConnectivityHandlerOptions): void {
  ipcMain.handle('runtimeEnvironments:list', () =>
    listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
  )
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => {
      const environment = addEnvironmentFromPairingCode(getUserDataPath(), args)
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      return { environment: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:verifyAndAddFromPairingCode',
    async (_event, args: { name: string; pairingCode: string; allowLoopback?: boolean }) => {
      const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        clearRuntimeEnvironmentManualDisconnect(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle('runtimeEnvironments:resolve', (_event, args: { selector: string }) =>
    redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (_event, args: { selector: string }): { removed: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (store.getSettings().activeRuntimeEnvironmentId === environment.id) {
        throw new Error('Choose another Active Server in Advanced before removing this server.')
      }
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      clearRuntimeEnvironmentCapabilityEvidence(removed.id)
      clearRuntimeEnvironmentManualDisconnect(removed.id)
      const retiring = Promise.resolve(invalidateTransport(removed.id))
      closeLegacySelectorTransport(args.selector, removed.id)
      // Why: removal is an explicit lifecycle decision, so its client-hosted browser storage goes
      // too -- but only once the client host releases its partitions, or every one refuses as live.
      void retireBrowserRoutePartitionStorageForEnvironment({
        environmentId: removed.id,
        whenClientHostClosed: retiring,
        clearStorage: clearBrowserRoutePartitionStorageForEnvironment,
        onError: (error) => {
          console.warn('[runtime-environments] browser partition storage clear failed:', error)
        }
      }).catch((error) => {
        console.warn('[runtime-environments] browser partition storage clear failed:', error)
      })
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      markRuntimeEnvironmentManuallyDisconnected(environment.id)
      invalidateTransport(environment.id)
      closeLegacySelectorTransport(args.selector, environment.id)
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:connect',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      return getRuntimeEnvironmentStatus(getUserDataPath(), environment.id, args.timeoutMs)
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:retryControlConnection',
    (_event, args: { selector: string }): void => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (!isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        retryRemoteRuntimeSharedControlConnectionNow(environment.id)
      }
    }
  )
}

export function registerRuntimeEnvironmentPassiveHandlers(getUserDataPath: () => string): void {
  registerPassiveStatusHandler(getUserDataPath)
  registerPassiveCallHandler(getUserDataPath)
}

function closeLegacySelectorTransport(selector: string, environmentId: string): void {
  if (selector === environmentId) {
    return
  }
  closeRemoteRuntimeRequestConnection(selector)
  clearSharedControlSupport(selector)
}

function registerPassiveStatusHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number; observeOnly?: true }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs,
        args.observeOnly ? { observeOnly: true } : undefined
      )
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}

function runtimeEnvironmentCallFailure(
  environment: ReturnType<typeof resolveEnvironment>,
  method: string,
  error: unknown
): RuntimeRpcFailure | null {
  if (
    !(error instanceof RemoteRuntimeClientError) &&
    !(error instanceof RuntimeRpcCallQueueOverloadError)
  ) {
    return null
  }
  return {
    id: method,
    ok: false,
    error: { code: error.code, message: error.message },
    _meta: { runtimeId: environment.runtimeId }
  }
}

function registerPassiveCallHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      let response: RuntimeRpcResponse<unknown>
      try {
        response = await callRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          args.expectedEnvironmentPairingRevision
        )
      } catch (error) {
        const failure = runtimeEnvironmentCallFailure(environment, args.method, error)
        if (failure) {
          return failure
        }
        throw error
      }
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}
