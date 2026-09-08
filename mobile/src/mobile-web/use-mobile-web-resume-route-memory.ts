import { useMemo, useRef } from 'react'
import type { MobileWebResumeRoute } from '../../../src/shared/mobile-web/bridge-contract'

export type MobileWebResumeRouteMemory = {
  remember: (route: MobileWebResumeRoute, pageState?: string) => void
  current: () => MobileWebResumeRoute
  pageState: () => string | undefined
}

/** The route the shell replays in `init` when the hosted document reloads. A package swap or a
 *  recovery mints a new shell session on the same host, and the reloaded page belongs on the route
 *  the user was reading — discarding it there boots the page on the workspace list and leaves the
 *  slow cold-resume round trip to bring the session back. Only another host makes the remembered
 *  workspace id meaningless. */
export function useMobileWebResumeRouteMemory(
  hostId: string | undefined
): MobileWebResumeRouteMemory {
  const rememberedRef = useRef<{
    hostId: string | undefined
    route: MobileWebResumeRoute
    pageState?: string
  }>({
    hostId,
    route: { kind: 'workspaceList' }
  })
  return useMemo(
    () => ({
      remember: (route, pageState) => {
        rememberedRef.current = { hostId, route, pageState }
      },
      current: () =>
        rememberedRef.current.hostId === hostId
          ? rememberedRef.current.route
          : { kind: 'workspaceList' },
      pageState: () =>
        rememberedRef.current.hostId === hostId ? rememberedRef.current.pageState : undefined
    }),
    [hostId]
  )
}
