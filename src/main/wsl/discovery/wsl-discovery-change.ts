const listeners = new Set<() => void>()
let queued = false

/** Runtime resolution reads the WSL discovery caches, so a changed answer can move a repo's Git route. */
export function onWslDiscoveryChanged(listener: () => void): void {
  listeners.add(listener)
}

export function notifyWslDiscoveryChanged(): void {
  if (listeners.size === 0 || queued) {
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
