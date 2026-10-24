import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../../../native-chat/transcript-watch'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../native-chat/ssh-transcript-path'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'
import {
  boundNativeChatRpcPageByBytes,
  nativeChatRpcAppendBatches
} from './native-chat-rpc-page-bounds'
import {
  MOBILE_NATIVE_CHAT_MAX_WINDOW,
  NativeChatSession,
  NativeChatUnsubscribe
} from '../../../../shared/rpc-contract/native-chat-params'

// Default to a small transcript tail for fast paired-client paint; clients page older history, while local IPC stays virtualized.
const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40

function sanitizeMessage(
  message: NativeChatMessage,
  clientKind: RpcContext['clientKind']
): NativeChatMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => sanitizeNativeChatRpcBlock(block, clientKind))
  }
}

function sanitizeAppendForClient(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind']
): NativeChatMessage[] {
  return messages.map((message) => sanitizeMessage(message, clientKind))
}

/** Window every RPC client by message count; apply mobile-only character clipping separately. */
function windowTranscript(
  messages: readonly NativeChatMessage[],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
): NativeChatMessage[] {
  const window = Math.min(Math.max(limit, 1), MOBILE_NATIVE_CHAT_MAX_WINDOW)
  return messages.length > window ? messages.slice(-window) : messages.slice()
}

function pageForClient(
  messages: readonly NativeChatMessage[],
  hasMore: boolean,
  beforeOffset: number,
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  agent?: string
): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const isOpenCode = resolveNativeChatTranscriptAgent(agent) === 'opencode'
  const sanitized = (isOpenCode ? messages : windowTranscript(messages, limit)).map((message) =>
    sanitizeMessage(message, clientKind)
  )
  return isOpenCode
    ? boundNativeChatRpcPageByBytes(sanitized, hasMore, beforeOffset)
    : { messages: sanitized, hasMore, beforeOffset }
}

export const NATIVE_CHAT_METHODS = [
  defineMethod({
    name: 'nativeChat.readSession',
    permission: 'workspace',
    params: NativeChatSession,
    handler: async (params, { runtime, clientKind, signal }) => {
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const result = await readNativeChatTranscriptTail(
        {
          agent: params.agent,
          sessionId: params.sessionId,
          transcriptPath: nativeChatTranscriptPathOnExecutionHost(
            runtime.getAgentProviderSessionRows(),
            params.sessionId,
            params.transcriptPath
          ),
          limit,
          beforeOffset: params.beforeOffset
        },
        signal
      )
      return 'messages' in result
        ? {
            ...pageForClient(
              result.messages,
              result.hasMore,
              result.beforeOffset,
              clientKind,
              limit,
              params.agent
            ),
            ...(result.lifecycle ? { lifecycle: result.lifecycle } : {})
          }
        : result
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    permission: 'workspace',
    params: NativeChatSession,
    handler: async (params, { runtime, connectionId, clientKind, signal }, emit) => {
      if (signal?.aborted) {
        return
      }
      let closed = false
      let unsubscribe = (): void => {}
      const setupController = new AbortController()
      // Drain a bounded tail first, then appended turns merged by id. Use the supplied cleanup token or legacy agent:sessionId so unsubscribe matches.
      const cleanupToken = params.subscriptionId ?? `${params.agent}:${params.sessionId}`
      const subscriptionId = `nativeChat:${connectionId ?? 'local'}:${cleanupToken}`
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const cleanup = (): void => {
        if (closed) {
          return
        }
        closed = true
        signal?.removeEventListener('abort', handleAbort)
        setupController.abort()
        unsubscribe()
        emit({ type: 'end' })
      }
      function handleAbort(): void {
        runtime.cleanupSubscription(subscriptionId)
      }
      signal?.addEventListener('abort', handleAbort, { once: true })
      runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
      if (signal?.aborted) {
        runtime.cleanupSubscription(subscriptionId)
        return
      }
      if (closed) {
        return
      }
      const subscribeArgs: SubscribeNativeChatTranscriptArgs = {
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: nativeChatTranscriptPathOnExecutionHost(
          runtime.getAgentProviderSessionRows(),
          params.sessionId,
          params.transcriptPath
        ),
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle) => {
          if (closed) {
            return
          }
          // Emit initial-read errors so a watching view cannot remain loading forever.
          emit({
            type: 'snapshot',
            ...pageForClient(messages, hasMore, beforeOffset, clientKind, limit, params.agent),
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        ...(params.capabilities?.transcriptPending === 1
          ? {
              onTranscriptPending: () => {
                if (!closed) {
                  emit({ type: 'snapshot', messages: [], hasMore: false, pending: true })
                }
              }
            }
          : {}),
        onReplace: (messages, hasMore, beforeOffset, lifecycle) => {
          if (closed) {
            return
          }
          emit({
            type: 'replacement',
            ...pageForClient(messages, hasMore, beforeOffset, clientKind, limit, params.agent),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle) => {
          if (closed) {
            return
          }
          const sanitized = sanitizeAppendForClient(messages, clientKind)
          const batches =
            sanitized.length > 0 && resolveNativeChatTranscriptAgent(params.agent) === 'opencode'
              ? nativeChatRpcAppendBatches(sanitized)
              : [sanitized]
          for (const batch of batches) {
            emit({
              type: 'appended',
              messages: batch,
              ...(lifecycle && batch === batches.at(-1) ? { lifecycle } : {})
            })
          }
        }
      }
      let subscription: NativeChatTranscriptSubscription
      try {
        subscription = await subscribeNativeChatTranscript(subscribeArgs, setupController.signal)
      } catch (error) {
        if (closed || setupController.signal.aborted) {
          return
        }
        throw error
      }
      // The connection may have closed while the file was being resolved.
      if (closed) {
        subscription.unsubscribe()
        return
      }
      if (!subscription.watching) {
        emit({
          type: 'snapshot',
          messages: [],
          hasMore: false,
          error: 'Transcript unavailable'
        })
      }
      unsubscribe = subscription.unsubscribe
    }
  }),
  defineMethod({
    name: 'nativeChat.unsubscribe',
    permission: 'workspace',
    params: NativeChatUnsubscribe,
    handler: async (params, { runtime, connectionId }) => {
      const connection = connectionId ?? 'local'
      if (params.subscriptionId) {
        runtime.cleanupSubscription(`nativeChat:${connection}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      runtime.cleanupSubscriptionsByPrefix(`nativeChat:${connection}:`)
      return { unsubscribed: true }
    }
  })
]
