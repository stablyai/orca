import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../../../native-chat/transcript-watch'
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

// Why: a long agent session can hold thousands of turns (with full tool I/O).
// Shipping all of them over the paired connection and rendering them at once
// freezes the mobile app, so the runtime RPC windows to the most recent slice —
// the conversation tail is what the chat view shows first. The desktop IPC path
// is unaffected (it reads locally with a virtualized list).
// Small first page for a fast initial paint; the client raises `limit` to load
// older history as the user scrolls back.
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

/** Window a transcript to its most recent `limit` messages so a long session
 *  can't freeze the client. Windowing by count applies to ALL RPC clients —
 *  shipping thousands of turns over the paired link is bad for web and mobile
 *  alike. Char-clipping (the mobile-only payload diet) is applied separately. */
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
    params: NativeChatSession,
    handler: async (params, { clientKind, signal }) => {
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const result = await readNativeChatTranscriptTail(
        {
          agent: params.agent,
          sessionId: params.sessionId,
          transcriptPath: params.transcriptPath,
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
    params: NativeChatSession,
    handler: async (params, { runtime, connectionId, clientKind, signal }, emit) => {
      if (signal?.aborted) {
        return
      }
      let closed = false
      let unsubscribe = (): void => {}
      const setupController = new AbortController()
      // Why: the first drain is a bounded tail snapshot; later drains emit only
      // appended turns. This avoids parsing or shipping full long transcripts.
      // Clients merge by message id, so the initial windowed batch doubles as the
      // snapshot. Keyed by the client-supplied subscriptionId when present so
      // registration and unsubscribe derive from the same token; otherwise by
      // agent:sessionId, which is exactly the token existing mobile clients send to
      // unsubscribe (no wire break).
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
        transcriptPath: params.transcriptPath,
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle, asyncQuestions) => {
          if (closed) {
            return
          }
          // Forward an initial-drain error so a watching client's first frame carries it
          // instead of stranding the view at 'loading' when the read keeps throwing.
          emit({
            type: 'snapshot',
            ...pageForClient(messages, hasMore, beforeOffset, clientKind, limit, params.agent),
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {}),
            ...(asyncQuestions ? { asyncQuestions } : {})
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
        onReplace: (messages, hasMore, beforeOffset, lifecycle, asyncQuestions) => {
          if (closed) {
            return
          }
          emit({
            type: 'replacement',
            ...pageForClient(messages, hasMore, beforeOffset, clientKind, limit, params.agent),
            ...(lifecycle ? { lifecycle } : {}),
            ...(asyncQuestions ? { asyncQuestions } : {})
          })
        },
        onAppend: (messages, lifecycle, asyncQuestions) => {
          if (closed) {
            return
          }
          const sanitized = sanitizeAppendForClient(messages, clientKind)
          const batches =
            sanitized.length > 0 && resolveNativeChatTranscriptAgent(params.agent) === 'opencode'
              ? nativeChatRpcAppendBatches(sanitized)
              : [sanitized]
          for (const batch of batches) {
            const last = batch === batches.at(-1)
            emit({
              type: 'appended',
              messages: batch,
              ...(lifecycle && last ? { lifecycle } : {}),
              ...(asyncQuestions && last ? { asyncQuestions } : {})
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
