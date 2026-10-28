import { useCallback, useSyncExternalStore } from 'react'

export type HostMachineDescriptor = {
  machineName: string | null
  platform: NodeJS.Platform | null
}

// Live descriptor state complements stored lastKnown fields; host-descriptor-recorder writes both.
const descriptorByHostId = new Map<string, HostMachineDescriptor>()
const listenersByHostId = new Map<string, Set<() => void>>()

// Record omissions too so readable status replies can clear stale fields.
export function recordHostDescriptor(hostId: string, descriptor: HostMachineDescriptor): void {
  const previous = descriptorByHostId.get(hostId)
  if (
    previous?.machineName === descriptor.machineName &&
    previous.platform === descriptor.platform
  ) {
    return
  }
  descriptorByHostId.set(hostId, descriptor)
  for (const listener of listenersByHostId.get(hostId) ?? []) {
    listener()
  }
}

/** Drops a removed host's entry so a later re-pair cannot inherit the dead pairing's descriptor. */
export function forgetHostDescriptor(hostId: string): void {
  if (!descriptorByHostId.delete(hostId)) {
    return
  }
  for (const listener of listenersByHostId.get(hostId) ?? []) {
    listener()
  }
}

function subscribe(hostId: string, listener: () => void): () => void {
  const listeners = listenersByHostId.get(hostId) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByHostId.set(hostId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByHostId.delete(hostId)
    }
  }
}

export function useHostDescriptor(hostId: string | undefined): HostMachineDescriptor | null {
  const read = useCallback(
    () => (hostId ? (descriptorByHostId.get(hostId) ?? null) : null),
    [hostId]
  )
  const subscribeToHost = useCallback(
    (listener: () => void) => (hostId ? subscribe(hostId, listener) : () => {}),
    [hostId]
  )
  return useSyncExternalStore(subscribeToHost, read, read)
}

export function resetHostDescriptorStoreForTests(): void {
  descriptorByHostId.clear()
  listenersByHostId.clear()
}
