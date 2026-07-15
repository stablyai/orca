import type { PtyProcessInfo } from '../providers/types'

type DaemonSessionRouteOwner = {
  listProcesses(): Promise<PtyProcessInfo[]>
}

export async function listAndRestoreDaemonSessionRoutes<T extends DaemonSessionRouteOwner>(
  owners: readonly T[],
  routes: Map<string, T>,
  shutdownOwners: { delete(id: string): void }
): Promise<PtyProcessInfo[]> {
  const inventories = await Promise.all(owners.map((owner) => owner.listProcesses()))
  const sessions: PtyProcessInfo[] = []
  for (const [index, ownerSessions] of inventories.entries()) {
    const owner = owners[index]!
    for (const session of ownerSessions) {
      sessions.push(session)
      if (!routes.has(session.id)) {
        // Why: graceful shutdown can retire fast liveness before native exit.
        // Reuse this inventory so destructive teardown still reaches its owner.
        routes.set(session.id, owner)
        shutdownOwners.delete(session.id)
      }
    }
  }
  return sessions
}
