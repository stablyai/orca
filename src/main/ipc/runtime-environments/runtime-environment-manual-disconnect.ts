import {
  requestDesktopBrowserBridgeReconcile,
  resetDesktopBrowserBridgeEnvironment
} from '../browser/desktop-browser-bridge-reconcile'

export const RUNTIME_MANUALLY_DISCONNECTED_MESSAGE = 'Runtime environment is manually disconnected.'

/** Environment id → why it is held disconnected, as the user reads it. */
const manualDisconnectReasons = new Map<string, string>()

export function markRuntimeEnvironmentManuallyDisconnected(
  environmentId: string,
  reason: string = RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
): void {
  manualDisconnectReasons.set(environmentId, reason)
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
