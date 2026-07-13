import { useEffect, useState } from 'react'
import { useCtx } from './client-context'

// Why (#6784): the real socket error from the last ws.onerror, so the
// connection verdict can render it instead of a canned label. Extracted from
// client-context.tsx to keep that file under its max-lines budget.
export function useLastConnectionError(hostId: string | undefined): string | null {
  const ctx = useCtx()
  const [, force] = useState(0)
  useEffect(() => {
    if (!hostId) {
      return
    }
    return ctx.subscribeHostState(hostId, () => force((n) => n + 1))
  }, [ctx, hostId])
  return hostId ? ctx.getLastConnectionError(hostId) : null
}
