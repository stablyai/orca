import { useEffect, useRef, useState } from 'react'
import * as z from 'zod'
import type { ClaudeSessionStatus } from '../../../../src/shared/native-chat/claude-session-status'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const REFRESH_DEBOUNCE_MS = 1_000
// The statusline can report the window without a new transcript row.
const POLL_INTERVAL_MS = 30_000

const statusReplySchema = z.object({
  status: z
    .object({
      model: z.string().nullable(),
      effort: z.string().nullable(),
      usedTokens: z.number().nullable(),
      windowTokens: z.number().nullable(),
      compactions: z.number()
    })
    .nullable()
})

const claudeSessionStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'nativeChat.claude-session-status-or-skip',
    method: 'nativeChat.claudeSessionStatus',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('claude-session-status', statusReplySchema)
  })
)

type ChatAnswer = { client: RpcClient; chatKey: string; status: ClaudeSessionStatus | null }

/** Status of the open terminal-backed Claude chat; null for hosts without the method. */
export function useMobileClaudeSessionStatus(args: {
  client: RpcClient | null
  agent: string | null
  sessionId: string | null
  transcriptPath?: string
  /** Changes when the transcript does. */
  refreshKey: string
  enabled: boolean
}): ClaudeSessionStatus | null {
  const { client, agent, sessionId, transcriptPath, refreshKey, enabled } = args
  const chatKey =
    enabled && client && agent && sessionId
      ? JSON.stringify([agent, sessionId, transcriptPath ?? null])
      : null
  const [answer, setAnswer] = useState<ChatAnswer | null>(null)
  const askRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!chatKey || !client || !agent || !sessionId) {
      return
    }
    let cancelled = false
    let methodMissing = false
    // Polls and refreshes overlap; only the latest request may set the status.
    let lastRequest = 0
    const params = { agent, sessionId, ...(transcriptPath ? { transcriptPath } : {}) }
    const askHost = async (): Promise<void> => {
      const request = ++lastRequest
      const response = await claudeSessionStatusRead.request(client, params)
      if (cancelled || request !== lastRequest) {
        return
      }
      if (!response.ok) {
        methodMissing = isMobileMethodUnavailableError(response.error.code, response.error.message)
        return
      }
      const reply = claudeSessionStatusRead.interpret(response)
      if (reply.accepted) {
        setAnswer({ client, chatKey, status: reply.value.status })
      }
    }
    const ask = (): void => {
      if (!methodMissing) {
        // A dropped connection is retried by the next poll; the last answer stays on screen.
        askHost().catch(() => {})
      }
    }
    askRef.current = ask
    ask()
    const poll = setInterval(ask, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      askRef.current = null
      clearInterval(poll)
    }
  }, [agent, chatKey, client, sessionId, transcriptPath])

  const lastRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) {
      return
    }
    lastRefreshKey.current = refreshKey
    const timer = setTimeout(() => askRef.current?.(), REFRESH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [refreshKey])

  return answer && answer.chatKey === chatKey && answer.client === client ? answer.status : null
}
