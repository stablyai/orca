import { useEffect, useState } from 'react'
import type { NewChatPermissionSettings } from '../../../src/shared/agent-chat-permission-mode'
import { nativeChatNewChatPermissionRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'

/** The host settings that pick a new chat's permission; null until this host has answered. */
export function useMobileNewChatPermission(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null
): NewChatPermissionSettings | null {
  // Tagged with its client so another host never inherits this one's answer.
  const [answer, setAnswer] = useState<{
    client: RpcClient
    settings: NewChatPermissionSettings
  } | null>(null)
  useEffect(() => {
    if (!client || !connected || !sessionId) {
      return
    }
    let stale = false
    void nativeChatNewChatPermissionRead
      .request(client)
      .then((response) => {
        const result = nativeChatNewChatPermissionRead.interpret(response)
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
  return answer && answer.client === client ? answer.settings : null
}
