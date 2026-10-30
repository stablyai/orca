import { useEffect, useState } from 'react'
import { nativeChatFollowUpBehaviorRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'

// Read per connection and chat: the phone has no settings stream, and Steer is the default.
export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null
): boolean {
  const [queueFollowUps, setQueueFollowUps] = useState(false)
  useEffect(() => {
    if (!client || !connected || !sessionId) {
      return
    }
    let stale = false
    void nativeChatFollowUpBehaviorRead
      .request(client)
      .then((response) => {
        const preference = nativeChatFollowUpBehaviorRead.interpret(response)
        if (!stale && preference.accepted) {
          setQueueFollowUps(preference.value === 'queue')
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
