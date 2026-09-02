export type SystemPowerLifecycleListener = {
  onSuspend: () => void
  onResume: () => void
}

type SystemPowerState = 'awake' | 'suspended'

const listeners = new Set<SystemPowerLifecycleListener>()
let state: SystemPowerState = 'awake'

function notifyListener(listener: SystemPowerLifecycleListener, nextState: SystemPowerState): void {
  try {
    if (nextState === 'suspended') {
      listener.onSuspend()
    } else {
      listener.onResume()
    }
  } catch (error) {
    console.error('[power] System lifecycle listener failed:', error)
  }
}

export function subscribeSystemPowerLifecycle(listener: SystemPowerLifecycleListener): () => void {
  listeners.add(listener)
  notifyListener(listener, state)
  return () => listeners.delete(listener)
}

export function publishSystemSuspend(): void {
  state = 'suspended'
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}

export function publishSystemResume(): void {
  state = 'awake'
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}
