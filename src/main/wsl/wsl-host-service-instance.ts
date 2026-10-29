import type { WslHostService } from './wsl-host-service'
import type { WslHostPhoneGate } from './wsl-host-phone-reach'

let instance: WslHostService | null = null

/** Null where WSL hosts cannot exist (not Windows, no e2e fake). */
export function getWslHostService(): WslHostService | null {
  return instance
}

export function setWslHostService(service: WslHostService | null): void {
  instance = service
}

let phoneGate: WslHostPhoneGate | null = null

/** Null wherever the service is. */
export function getWslHostPhoneGate(): WslHostPhoneGate | null {
  return phoneGate
}

export function setWslHostPhoneGate(gate: WslHostPhoneGate | null): void {
  phoneGate = gate
}
