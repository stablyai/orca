export type SystemPowerLifecycleListener = {
  onSuspend: () => void
  onResume: () => void
}

const listeners = new Set<SystemPowerLifecycleListener>()

export function subscribeSystemPowerLifecycle(listener: SystemPowerLifecycleListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishSystemSuspend(): void {
  for (const listener of Array.from(listeners)) {
    listener.onSuspend()
  }
}

export function publishSystemResume(): void {
  for (const listener of Array.from(listeners)) {
    listener.onResume()
  }
}
