import { useEffect, useState } from 'react'
import {
  nativeChatHostSettingsRead,
  type NativeChatHostSettings
} from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'

export type MobileNativeChatHostSettings = {
  queueFollowUps: boolean
  /** Null until this host has answered. */
  newChatPermission: NativeChatHostSettings['newChatPermission'] | null
}

const UNREAD: MobileNativeChatHostSettings = { queueFollowUps: true, newChatPermission: null }

// Read per connection and chat: the phone has no settings stream, and queueing on is today's default.
export function useMobileNativeChatHostSettings(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null
): MobileNativeChatHostSettings {
  // Tagged with its client so another host never inherits this one's answer.
  const [answer, setAnswer] = useState<{
    client: RpcClient
    settings: NativeChatHostSettings
  } | null>(null)
  useEffect(() => {
    if (!client || !connected || !sessionId) {
      return
    }
    let stale = false
    void nativeChatHostSettingsRead
      .request(client)
      .then((response) => {
        const result = nativeChatHostSettingsRead.interpret(response)
        if (!stale && result.accepted) {
          setAnswer({ client, settings: result.value })
        }
      })
      .catch(() => {
        // Keep the last answer when the host is unreachable.
      })
    return () => {
      stale = true
    }
  }, [client, connected, sessionId])
  return answer && answer.client === client ? answer.settings : UNREAD
}
