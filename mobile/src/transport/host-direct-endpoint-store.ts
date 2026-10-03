import { HostProfileSchema, type HostProfile } from './types'
import { mutateStoredHosts } from './host-list-mutation-queue'

export class DirectEndpointHostRemovedError extends Error {}

/**
 * Persists a refreshed direct dial address for a host that is still paired.
 * Unlike pairing's savePairedHost, this never inserts a row and never rewrites the device token
 * or relay overlay, so a refresh that loses the race with removeHost cannot recreate the host.
 */
export async function saveRefreshedDirectEndpoint(host: HostProfile): Promise<void> {
  const validated = HostProfileSchema.parse(host)
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((candidate) => candidate.id === validated.id)
    if (index === -1) {
      throw new DirectEndpointHostRemovedError('mobile direct endpoint host was removed')
    }
    const current = hosts[index]!
    if (current.endpoint === validated.endpoint) {
      return hosts
    }
    const next = hosts.slice()
    next[index] = { ...current, endpoint: validated.endpoint }
    return next
  })
}
