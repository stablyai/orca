import { useMemo, type ReactNode } from 'react'
import { useGlobalSearchParams, usePathname } from 'expo-router'
import { triggerEdgeBump } from '../platform/haptics'
import { firstParam } from './route-param-reader'
import { useRouteHandoff } from './route-handoff'
import { returnToHostSessionList, sessionListBackTarget } from './session-list-back'
import { SessionListLongPressContext } from './session-list-long-press-context'

// Mount under the router. Absent in tests, so a back control stays one-step.
export function SessionListLongPressProvider({ children }: { children: ReactNode }) {
  const router = useRouteHandoff()
  const pathname = usePathname()
  const hostId = firstParam(useGlobalSearchParams<{ hostId?: string | string[] }>().hostId)
  const href = hostId
    ? sessionListBackTarget({
        gesture: 'longPress',
        hostId,
        pathname,
        oneStepHref: pathname
      })
    : null
  const go = useMemo(() => {
    if (!href || !hostId) {
      return null
    }
    return () => {
      triggerEdgeBump()
      returnToHostSessionList(router, hostId)
    }
  }, [href, hostId, router])
  return (
    <SessionListLongPressContext.Provider value={go}>
      {children}
    </SessionListLongPressContext.Provider>
  )
}
