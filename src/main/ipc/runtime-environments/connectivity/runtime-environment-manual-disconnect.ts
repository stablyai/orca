import {
  requestDesktopBrowserBridgeReconcile,
  resetDesktopBrowserBridgeEnvironment
} from '../../browser/desktop-browser-bridge-reconcile'

export const RUNTIME_MANUALLY_DISCONNECTED_MESSAGE = 'Runtime environment is manually disconnected.'

/** Environment id → why it is held disconnected, as the user reads it. */
const manualDisconnectReasons = new Map<string, string>()
/** Environment id → how many times the user has disconnected it; a later reconnect keeps it. */
const manualDisconnects = new Map<string, number>()

export function markRuntimeEnvironmentManuallyDisconnected(
  environmentId: string,
  reason: string = RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
): void {
  manualDisconnectReasons.set(environmentId, reason)
  manualDisconnects.set(environmentId, (manualDisconnects.get(environmentId) ?? 0) + 1)
  // Disconnect must revoke the server's desktop browser access immediately.
  resetDesktopBrowserBridgeEnvironment(environmentId)
}

export function clearRuntimeEnvironmentManualDisconnect(environmentId: string): void {
  manualDisconnectReasons.delete(environmentId)
  requestDesktopBrowserBridgeReconcile()
}

export function isRuntimeEnvironmentManuallyDisconnected(environmentId: string): boolean {
  return manualDisconnectReasons.has(environmentId)
}

export function runtimeEnvironmentManualDisconnectReason(environmentId: string): string {
  return manualDisconnectReasons.get(environmentId) ?? RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
}

/** Counts the user's disconnects of an environment. Work started before one compares the count
 *  instead of the current flag, which a reconnect in between (such as a VM wake's own connect)
 *  clears. */
export function runtimeEnvironmentManualDisconnectCount(environmentId: string): number {
  return manualDisconnects.get(environmentId) ?? 0
}
