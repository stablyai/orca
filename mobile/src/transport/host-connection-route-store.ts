import { ConnectionRouteSchema, type ConnectionRoute } from './connection-route'
import { mutateStoredHosts, enqueueHostListMutation } from './host-list-mutation-queue'
import { readStoredHostProfilesForMutation } from './host-metadata-store'
import {
  pruneSshCredentialRegistry,
  hasSshCredentialCleanupCandidates
} from './ssh-credential-registry'
import { deleteSshRouteCredentials } from './ssh-route-credentials'
import { loadSshProfileIds } from '../ssh/ssh-profile-store'

export function updateHostConnectionRoute(
  hostId: string,
  route: ConnectionRoute | null
): Promise<void> {
  const validated = route === null ? null : ConnectionRouteSchema.parse(route)
  return mutateStoredHosts((hosts) => {
    if (!hosts.some((host) => host.id === hostId)) {
      throw new Error('Host was removed from this phone.')
    }
    return hosts.map((host) => {
      if (host.id !== hostId) {
        return host
      }
      const { connectionRoute: _previous, ...rest } = host
      return validated ? { ...rest, connectionRoute: validated } : rest
    })
  })
}

export async function cleanupSshCredentials(): Promise<void> {
  if (!(await hasSshCredentialCleanupCandidates())) {
    return
  }
  return enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    const profileIds = await loadSshProfileIds()
    // Why: a route's jump credential is referenced by the host, not by any profile
    // row, so pruning it here would break a host that still dials through it.
    const keep = new Set([
      ...hosts.flatMap((host) => {
        if (!host.connectionRoute) {
          return []
        }
        const jump = host.connectionRoute.jump
        return jump
          ? [host.connectionRoute.credentialId, jump.credentialId]
          : [host.connectionRoute.credentialId]
      }),
      ...profileIds
    ])
    await pruneSshCredentialRegistry(keep, deleteSshRouteCredentials)
  })
}
