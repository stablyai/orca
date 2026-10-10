import { useCallback } from 'react'
import type { ResetHostStack } from './use-reset-host-stack'
import { useRouteHandoff } from './route-handoff'

/** Web: the page owns no stack to reset, so it replaces the route through the route handoff,
 *  which keeps the page's own host local and hands other hosts to the shell. */
export function useResetHostStack(_currentHostId: string): ResetHostStack {
  const router = useRouteHandoff()
  return useCallback(
    (hostId, session) => {
      const host = `/h/${encodeURIComponent(hostId)}`
      if (!session) {
        router.replace(host)
        return
      }
      const query = session.name ? `?name=${encodeURIComponent(session.name)}` : ''
      router.replace(`${host}/session/${encodeURIComponent(session.worktreeId)}${query}`)
    },
    [router]
  )
}
