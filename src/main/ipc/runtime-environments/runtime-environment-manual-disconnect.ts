import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  requestDesktopBrowserBridgeReconcile,
  resetDesktopBrowserBridgeEnvironment
} from '../desktop-browser-bridge-reconcile'

const manuallyDisconnectedEnvironmentIds = new Set<string>()

export const RUNTIME_MANUALLY_DISCONNECTED_MESSAGE = 'Runtime environment is manually disconnected.'

export function markRuntimeEnvironmentManuallyDisconnected(environmentId: string): void {
  manuallyDisconnectedEnvironmentIds.add(environmentId)
  // Disconnect must revoke the server's desktop browser access immediately.
  resetDesktopBrowserBridgeEnvironment(environmentId)
}

export function clearRuntimeEnvironmentManualDisconnect(environmentId: string): void {
  manuallyDisconnectedEnvironmentIds.delete(environmentId)
  requestDesktopBrowserBridgeReconcile()
}

export function isRuntimeEnvironmentManuallyDisconnected(environmentId: string): boolean {
  return manuallyDisconnectedEnvironmentIds.has(environmentId)
}

export function manuallyDisconnectedResponse(environment: {
  runtimeId: string | null
}): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}
