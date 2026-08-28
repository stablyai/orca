// The paired session view telling the host it is looking at this chat.
//
// Same contract as the desktop chat's hold, over the mobile transport. It matters more here: a
// phone is the surface most likely to disappear without saying anything, so the host's own
// connection-close backstop is what usually ends up releasing this — the explicit release only
// covers the polite case of navigating away with the socket still up.
//
// A host that predates the method answers `method_not_found`; the session still reads.

import { useEffect } from 'react'
import type { RpcClient } from '../transport/rpc-client'

let holderOrdinal = 0

export function useMobileStructuredSessionHold(args: {
  client: RpcClient | null
  sessionId: string | null
}): void {
  const { client, sessionId } = args
  useEffect(() => {
    if (!client || !sessionId) {
      return
    }
    holderOrdinal += 1
    const holderId = `mobile-session:${holderOrdinal}`
    // Chained, not raced: unmounting during the hold's round trip would otherwise release a hold
    // that has not been taken yet.
    const held = client
      .sendRequest('agentSession.hold', { sessionId, holderId })
      .catch(() => undefined)
    return () => {
      void held.then(() =>
        client.sendRequest('agentSession.release', { sessionId, holderId }).catch(() => undefined)
      )
    }
  }, [client, sessionId])
}
