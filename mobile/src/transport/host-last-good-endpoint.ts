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
      await mutate((hosts) =>
        hosts.map((host) => (host.id === hostId ? { ...host, lastGoodEndpoint } : host))
      )
    } catch {
      // Why: last-good is a best-effort routing hint, never authoritative host data.
    }
  }
}
