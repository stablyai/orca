import { useCallback } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { RpcClient } from '../../../transport/rpc-client'
import { nativeChatSessionPageRead } from '../../mobile-session-read-operations'
import type { MobileNativeChatSubagentRead } from './use-mobile-native-chat-subagent-page'

const PAGE_TIMEOUT_MS = 15_000

function isNativeChatMessage(value: unknown): value is NativeChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'role' in value &&
    typeof value.role === 'string' &&
    'blocks' in value &&
    Array.isArray(value.blocks)
  )
}

function pageFrom(
  value: unknown,
  agentId: string
): Awaited<ReturnType<MobileNativeChatSubagentRead>> {
  if (typeof value !== 'object' || value === null) {
    return { error: 'Transcript unavailable' }
  }
  if ('error' in value && typeof value.error === 'string') {
    return { error: value.error }
  }
  if (!('messages' in value) || !Array.isArray(value.messages)) {
    return { error: 'Transcript unavailable' }
  }
  const stamped = value.messages.filter(isNativeChatMessage)
  const messages = stamped.filter((message) => message.agentId === agentId)
  // An older host ignores subagentId and returns the parent, which has no child stamp.
  if (stamped.length > 0 && messages.length === 0) {
    return { error: 'Transcript unavailable' }
  }
  return {
    messages,
    hasMore: 'hasMore' in value && value.hasMore === true,
    beforeOffset:
      'beforeOffset' in value && typeof value.beforeOffset === 'number' ? value.beforeOffset : 0
  }
}

/** Read one child through the same session page the parent uses. Null when the chat cannot read. */
export function useMobileNativeChatSubagentReader(args: {
  client: RpcClient | null
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
}): MobileNativeChatSubagentRead | null {
  const { client, agent, sessionId, transcriptPath } = args
  const read = useCallback<MobileNativeChatSubagentRead>(
    async (agentId, limit, beforeOffset) => {
      if (!client || !agent || !sessionId) {
        return { error: 'Transcript unavailable' }
      }
      try {
        const response = await nativeChatSessionPageRead.request(
          client,
          {
            agent,
            sessionId,
            limit,
            subagentId: agentId,
            capabilities: { transcriptSourceOrder: 1 },
            ...(beforeOffset !== undefined ? { beforeOffset } : {}),
            ...(transcriptPath ? { transcriptPath } : {})
          },
          { timeoutMs: PAGE_TIMEOUT_MS, budgetSpansConnect: true }
        )
        const accepted = nativeChatSessionPageRead.interpret(response)
        if (!accepted.accepted) {
          return { error: 'Transcript unavailable' }
        }
        return pageFrom(accepted.value, agentId)
      } catch {
        return { error: 'Transcript unavailable' }
      }
    },
    [agent, client, sessionId, transcriptPath]
  )
  if (!client || !agent || !sessionId) {
    return null
  }
  return read
}
