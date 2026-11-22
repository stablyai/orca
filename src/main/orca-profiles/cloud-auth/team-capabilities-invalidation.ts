let generation = 0
let queued = false
const listeners = new Set<() => void>()

export function teamCapabilitiesGeneration(): number {
  return generation
}

export function invalidateTeamCapabilities(): void {
  generation++
  if (queued || listeners.size === 0) {
    return
  }
  queued = true
  queueMicrotask(() => {
    queued = false
    for (const listener of listeners) {
      listener()
    }
  })
}

export function onTeamCapabilitiesInvalidated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
