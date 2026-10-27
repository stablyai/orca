import { useEffect, useState } from 'react'
import { nativeChatQueueFollowUpsRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'

// Read per connection and chat: the phone has no settings stream, and on is today's default.
export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null
): boolean {
  const [queueFollowUps, setQueueFollowUps] = useState(true)
  useEffect(() => {
    if (!client || !connected || !sessionId) {
      return
    }
    let stale = false
    void nativeChatQueueFollowUpsRead
      .request(client)
      .then((response) => {
        const preference = nativeChatQueueFollowUpsRead.interpret(response)
        if (!stale && preference.accepted) {
          setQueueFollowUps(preference.value)
        }
      })
      .catch(() => {
        // Keep the last answer when the host is unreachable.
      })
    return () => {
      stale = true
    }
  }, [client, connected, sessionId])
  return queueFollowUps
}
