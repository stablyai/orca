type StoredHost = { id: string; lastGoodEndpoint?: string }

export function createHostLastGoodEndpointUpdater<T extends StoredHost>(
  mutate: (update: (hosts: T[]) => T[]) => Promise<void>
): (hostId: string, endpoint: string) => Promise<void> {
  return async (hostId, endpoint) => {
    const lastGoodEndpoint = endpoint.trim()
    if (!lastGoodEndpoint) {
      return
    }
    try {
      await mutate((hosts) => {
        const index = hosts.findIndex((host) => host.id === hostId)
        if (index < 0 || hosts[index]!.lastGoodEndpoint === lastGoodEndpoint) {
          return hosts
        }
        const next = hosts.slice()
        next[index] = { ...next[index]!, lastGoodEndpoint }
        return next
      })
    } catch {
      // Why: last-good is a best-effort routing hint, never authoritative host data.
    }
  }
}
