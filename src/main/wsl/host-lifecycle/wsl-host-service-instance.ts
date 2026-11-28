import type { WslHostService } from './wsl-host-service'
import type { WslHostPhoneGate } from './wsl-host-phone-reach'

let instance: WslHostService | null = null

/** Null where WSL hosts cannot exist (not Windows, no e2e fake). */
export function getWslHostService(): WslHostService | null {
  return instance
}

const statusListeners = new Set<() => void>()
let stopForwardingStatuses: (() => void) | null = null
const serviceListeners = new Set<(service: WslHostService) => void>()

export function setWslHostService(service: WslHostService | null): void {
  stopForwardingStatuses?.()
  instance = service
  stopForwardingStatuses =
    service?.onStatusesChanged(() => {
      for (const listener of statusListeners) {
        listener()
      }
    }) ?? null
  if (service) {
    for (const listener of serviceListeners) {
      listener(service)
    }
  }
}

/** Every service installed from now on; startup sets it after the IPC that needs it registers. */
export function onWslHostServiceSet(listener: (service: WslHostService) => void): () => void {
  serviceListeners.add(listener)
  return () => serviceListeners.delete(listener)
}

/** Statuses of whichever service is installed, now or later. */
export function onWslHostStatusesChanged(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

let phoneGate: WslHostPhoneGate | null = null

/** Null wherever the service is. */
export function getWslHostPhoneGate(): WslHostPhoneGate | null {
  return phoneGate
}

export function setWslHostPhoneGate(gate: WslHostPhoneGate | null): void {
  phoneGate = gate
}
