import { useMemo } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { leaveHostRoute } from '../host-route-exit'
import { useForceReconnect, useForgetHostClient } from '../transport/client-context'
import { loadHostCatalog } from '../transport/host-store'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY } from '../mobile-web/mobile-web-native-capability-authority'
import { navigateFromHostScreenList } from './host-screen-route-navigation'
import type { HostScreenShellOperations } from './host-screen-shell-operations'

export function useDefaultHostScreenShellOperations(args: {
  hostId: string | undefined
  embedded: boolean
}): HostScreenShellOperations {
  const router = useRouter()
  const pathname = usePathname()
  const closeHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()

  return useMemo(
    () => ({
      leaveHost() {
        leaveHostRoute(router)
      },
      navigateFromHostList(target: string) {
        navigateFromHostScreenList({
          router,
          pathname,
          target,
          embedded: args.embedded,
          hostId: args.hostId
        })
      },
      openConnectionDiagnostics() {
        router.push({ pathname: '/connection-log', params: { hostId: args.hostId ?? '' } })
      },
      openExternalUrl(url: string) {
        return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.openExternal(url)
      },
      reconnect() {
        return args.hostId ? forceReconnectHost(args.hostId) : Promise.resolve()
      },
      repairPairing() {
        router.push('/pair-scan')
      },
      async removeHost() {
        const hostId = args.hostId
        if (!hostId) {
          throw new Error('Host identity unavailable')
        }
        // Why: only the hybrid cache purge needs the key, and that purge is best-effort — so
        // resolve it here instead of letting a Remove tap race the host screen's identity read.
        const catalog = await loadHostCatalog().catch(() => [])
        const hostPublicKey = catalog.find((entry) => entry.id === hostId)?.publicKeyB64 ?? ''
        await removeHostAndCloseClient(hostId, hostPublicKey, closeHostClient)
      }
    }),
    [args.embedded, args.hostId, closeHostClient, forceReconnectHost, pathname, router]
  )
}
