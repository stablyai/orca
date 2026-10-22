import { useEffect } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'

/**
 * An overlay whose page cannot show (a blocked or older desktop, a failed load, no connection):
 * the host list opens full screen in its place, where that host's state is shown.
 */
export function OpenHostListInstead({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  useEffect(() => {
    router.replace(`/h/${encodeURIComponent(hostId)}`)
  }, [hostId, router])
  return null
}
