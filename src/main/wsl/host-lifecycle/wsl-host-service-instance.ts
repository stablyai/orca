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

/** Once, with the installed service or the next one: startup installs it after its consumers register. */
export function whenWslHostServiceSet(listener: (service: WslHostService) => void): () => void {
  if (instance) {
    listener(instance)
    return () => {}
  }
  const once = (service: WslHostService): void => {
    serviceListeners.delete(once)
    listener(service)
  }
  serviceListeners.add(once)
  return () => serviceListeners.delete(once)
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
