// Set while the live agent notification keeps the app running in the background (live-alerts).
// Endpoint lifecycles read it so a backgrounded app keeps its relay instead of suspending it.
let active = false
const listeners = new Set<(active: boolean) => void>()

export function isBackgroundKeepAliveActive(): boolean {
  return active
}

export function setBackgroundKeepAlive(next: boolean): void {
  if (next === active) {
    return
  }
  active = next
  for (const listener of listeners) {
    listener(next)
  }
}

export function subscribeBackgroundKeepAlive(listener: (active: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
