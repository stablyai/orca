const manuallyDisconnectedEnvironmentIds = new Set<string>()

export const RUNTIME_MANUALLY_DISCONNECTED_MESSAGE = 'Runtime environment is manually disconnected.'

export function markRuntimeEnvironmentManuallyDisconnected(environmentId: string): void {
  manuallyDisconnectedEnvironmentIds.add(environmentId)
}

export function clearRuntimeEnvironmentManualDisconnect(environmentId: string): void {
  manuallyDisconnectedEnvironmentIds.delete(environmentId)
}

export function isRuntimeEnvironmentManuallyDisconnected(environmentId: string): boolean {
  return manuallyDisconnectedEnvironmentIds.has(environmentId)
}
