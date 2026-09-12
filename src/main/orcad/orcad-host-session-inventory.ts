import { listLiveDaemonSessions } from '../daemon/daemon-init'
import {
  delegatedPtyProviderRoutesRevision,
  hasDelegatedPtyProviderRoute,
  snapshotDelegatedPtyProviderRoutes
} from '../ipc/pty/provider/delegated-provider-routes'
import { readRegisteredPtyProviderInventory } from '../ipc/pty/provider/registered-provider-inventory'

export async function readOrcadHostSessionInventory(): Promise<{ createdAt: number }[] | null> {
  const revision = delegatedPtyProviderRoutesRevision()
  const routes = snapshotDelegatedPtyProviderRoutes()
  try {
    const [native, delegated] = await Promise.all([
      listLiveDaemonSessions(),
      Promise.all(
        routes.map(async (route) => {
          const sessions = await readRegisteredPtyProviderInventory({
            connectionId: null,
            delegatedIdentity: route.identity,
            provider: route.provider,
            isCurrent: route.isCurrent
          })
          // Source birth is not destination admission; rollback needs the latter's durable timestamp.
          return sessions.map(() => ({ createdAt: 0 }))
        })
      )
    ])
    if (
      !native ||
      revision !== delegatedPtyProviderRoutesRevision() ||
      routes.some((route) => !route.isCurrent())
    ) {
      return null
    }
    return [
      ...native.filter((session) => !hasDelegatedPtyProviderRoute(session.sessionId)),
      ...delegated.flat()
    ]
  } catch {
    return null
  }
}
