const listeners = new Set<() => void>()
let revision = 0

/** Runtime resolution reads the WSL discovery caches, so a changed answer can move a repo's Git route. */
export function onWslDiscoveryChanged(listener: () => void): void {
  listeners.add(listener)
}

export function getWslDiscoveryRevision(): number {
  return revision
}

/** Synchronous: owners must stop trusting a route the new answer replaced before anything else runs. */
export function notifyWslDiscoveryChanged(): void {
  revision += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      // A listener failure must not break the discovery write that notified it.
      console.warn('[wsl] discovery change listener failed:', error)
    }
  }
}
