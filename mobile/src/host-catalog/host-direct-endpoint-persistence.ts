import { withHostDirectEndpoints } from './host-direct-endpoint-refresh'
import { mutateStoredHosts } from './host-list-mutation-queue'

/** Apply the desktop's current direct endpoints; resolves to the row's endpoint afterwards, or null once removed. */
export async function recordHostDirectEndpoints(
  hostId: string,
  endpoints: readonly string[]
): Promise<string | null> {
  let endpoint: string | null = null
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index === -1) {
      return hosts
    }
    const current = hosts[index]!
    const updated = withHostDirectEndpoints(current, endpoints)
    endpoint = updated.endpoint
    if (updated === current) {
      return hosts
    }
    const next = hosts.slice()
    next[index] = updated
    return next
  })
  return endpoint
}
