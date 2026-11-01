import { useEffect } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'

// Replace unavailable overlay pages with the full host list so its status/failure remains visible.
export function OpenHostListInstead({ hostId }: { hostId: string }) {
  const router = useRouteHandoff()
  useEffect(() => {
    router.replace(`/h/${encodeURIComponent(hostId)}`)
  }, [hostId, router])
  return null
}
