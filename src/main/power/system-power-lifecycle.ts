export type SystemPowerLifecycleListener = {
  onSuspend: () => void
  onResume: () => void
}

export type SystemPowerState = 'awake' | 'suspended'

const listeners = new Set<SystemPowerLifecycleListener>()
let state: SystemPowerState = 'awake'
/** Suspends published since the process started, and every power event: a reading taken before
 *  either changes may no longer describe the machine. */
let suspends = 0
let generation = 0

export function systemSuspendCount(): number {
  return suspends
}

export function systemPowerGeneration(): number {
  return generation
}

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

export function getSystemPowerState(): SystemPowerState {
  return state
}

export function subscribeSystemPowerLifecycle(listener: SystemPowerLifecycleListener): () => void {
  listeners.add(listener)
  notifyListener(listener, state)
  return () => listeners.delete(listener)
}

export function publishSystemSuspend(): void {
  state = 'suspended'
  suspends += 1
  generation += 1
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}

export function publishSystemResume(): void {
  state = 'awake'
  generation += 1
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}
