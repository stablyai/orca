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
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { Store } from '../persistence'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus
} from './runtime-environment-transport-routing'

const manuallyDisconnectedEnvironmentIds = new Set<string>()

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

export function isRuntimeEnvironmentManuallyDisconnected(environmentId: string): boolean {
  return manuallyDisconnectedEnvironmentIds.has(environmentId)
}

type ConnectivityHandlerOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => void
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
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { environment: redactRuntimeEnvironment(environment) }
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
      manuallyDisconnectedEnvironmentIds.delete(removed.id)
      invalidateTransport(removed.id)
      closeLegacySelectorTransport(args.selector, removed.id)
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      manuallyDisconnectedEnvironmentIds.add(environment.id)
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
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return getRuntimeEnvironmentStatus(getUserDataPath(), environment.id, args.timeoutMs)
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
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs
      )
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
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
      const response = await callRuntimeEnvironment(
        getUserDataPath(),
        environment.id,
        args.method,
        args.params,
        args.timeoutMs,
        args.expectedEnvironmentPairingRevision
      )
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}
