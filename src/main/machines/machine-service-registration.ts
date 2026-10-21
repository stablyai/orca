import type { MachineService } from './machine-service'

// Why its own module: runtime RPC reads this without loading the desktop wiring (electron, IPC).
let registered: { service: MachineService; isEnabled: () => boolean } | null = null

export function registerMachineService(service: MachineService, isEnabled: () => boolean): void {
  registered = { service, isEnabled }
}

/** The host's MachineService for runtime RPC; null where none is registered or the flag is off. */
export function getMachineService(): MachineService | null {
  return registered?.isEnabled() ? registered.service : null
}
