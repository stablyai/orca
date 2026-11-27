import type { DaemonClient } from '../daemon/transport/client/daemon-client'

/**
 * Who waits to hear that a daemon start is reachable again, by its hello nonce. Each client is
 * watched once; a completed hello wakes only the watchers of the start it reached. A relay's
 * attach and exit events go only to the client attached to it, which a run still waiting on its
 * start never has here, so a hello is the one signal such a run can get.
 */
const watchers = new Map<string, Set<() => void>>()
const watched = new WeakSet<DaemonClient>()

export function watchProviderRelayInstance(instance: string, wake: () => void): () => void {
  const set = watchers.get(instance) ?? new Set<() => void>()
  set.add(wake)
  watchers.set(instance, set)
  return () => {
    set.delete(wake)
    if (set.size === 0 && watchers.get(instance) === set) {
      watchers.delete(instance)
    }
  }
}

export function watchProviderRelayClient(client: DaemonClient): void {
  if (watched.has(client)) {
    return
  }
  watched.add(client)
  client.connectedListeners.add(() => {
    const instance = client.getDaemonIdentity()?.launchNonce
    for (const wake of (instance ? watchers.get(instance) : undefined) ?? []) {
      wake()
    }
  })
}
