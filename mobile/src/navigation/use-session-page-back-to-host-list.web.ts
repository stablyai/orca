import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import { hostStackHostRoute } from './host-stack-navigation'
import { firstParam } from './route-param-reader'
import { useBackClaim } from './use-back-claim.web'
import { useSessionHostListBeneath } from './use-session-host-list-beneath'

function backToListedHost(
  router: {
    canGoBack: () => boolean
    back: () => void
    replace: (href: ReturnType<typeof hostStackHostRoute>) => void
  },
  hostId: string
): () => boolean {
  return () => {
    if (router.canGoBack()) {
      router.back()
      return true
    }
    router.replace(hostStackHostRoute(hostId))
    return true
  }
}

// A shell-opened session document keeps the native swipe. Repairing its web history would claim Back and swallow that swipe.
export function useSessionPageBackToHostList(): void {
  const hostId = firstParam(useLocalSearchParams<{ hostId?: string | string[] }>().hostId)
  const router = useRouter()
  const shellPath = usePageBridgeClientIfPresent()?.getShellSession()?.route?.pathname ?? null
  const nativeSessionDocument = shellPath !== null && shellPath.includes('/session/')
  const repairHostId = nativeSessionDocument || hostId === '' ? null : hostId
  useSessionHostListBeneath(repairHostId)
  // Claim Back while this session is inside a host document. Otherwise the native swipe pops that document to the server list.
  useBackClaim(repairHostId === null ? null : backToListedHost(router, repairHostId))
}
