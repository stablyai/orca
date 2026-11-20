import { verifySessionTranscriptRanges } from '../../../../native-chat/transcript-watching/verify-session-transcript-ranges'
import { recordMobileViewOpened } from '../../../../telemetry/mobile-client-telemetry'
import type { NativeChatTranscriptFrame } from '../../../../../shared/native-chat/transcript/streaming/native-chat-transcript-frames'
import { resolveNativeChatTranscriptAgent } from '../../../../../shared/native-chat/native-chat-agent-support'
import { subscribeNativeChatTranscript } from '../../../../native-chat/transcript-watch'
import { readNativeChatTranscriptTail } from '../../../../native-chat/transcript-tail-reader'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from '../../../../native-chat/transcript-watching/transcript-watch-contract'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../../native-chat/transcript-filesystem/ssh-transcript-path'
import { defineMethod, defineStreamingMethod } from '../../core'
import { nativeChatRpcAppendBatches } from './native-chat-rpc-page-bounds'
import {
  NativeChatSession,
  NativeChatVerifyRanges,
  NativeChatUnsubscribe
} from '../../../../../shared/rpc-contract/native-chat/native-chat-params'

import {
  MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  pageForClient,
  resumeIndex,
  sanitizeAppendForClient
} from './native-chat-rpc-pages'

export const NATIVE_CHAT_METHODS = [
  defineMethod({
    name: 'nativeChat.verifyTranscriptRanges',
    permission: 'workspace',
    params: NativeChatVerifyRanges,
    handler: (params, { runtime, signal }) =>
      verifySessionTranscriptRanges(
        {
          ...params,
          transcriptPath: nativeChatTranscriptPathOnExecutionHost(
            runtime.getAgentProviderSessionRows(),
            params.sessionId,
            params.transcriptPath
          )
        },
        signal
      )
  }),
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
          beforeOffset: params.beforeOffset,
          sourceOrder: params.capabilities?.transcriptSourceOrder === 1
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
              params.agent,
              result.ranges
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
    handler: async (
      params,
      { runtime, connectionId, clientKind, pairedDeviceId, signal },
      emitAny
    ) => {
      const emit = (frame: NativeChatTranscriptFrame): void => emitAny(frame)
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
        sourceOrder: params.capabilities?.transcriptSourceOrder === 1,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle, ranges) => {
          if (closed) {
            return
          }
          const resumeAt = resumeIndex(messages, params.resumeAfter, params.agent)
          const resumed = resumeAt !== -1
          // Emit initial-read errors so a watching view cannot remain loading forever.
          emit({
            type: 'snapshot',
            ...pageForClient(
              resumed ? messages.slice(resumeAt) : messages,
              resumeAt > 0 || hasMore,
              resumed ? messages[resumeAt].transcriptOrder! : beforeOffset,
              clientKind,
              limit,
              params.agent,
              resumed ? undefined : ranges
            ),
            ...(resumed ? { resumed } : {}),
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
        onReplace: (messages, hasMore, beforeOffset, lifecycle, ranges) => {
          if (closed) {
            return
          }
          emit({
            type: 'replacement',
            ...pageForClient(
              messages,
              hasMore,
              beforeOffset,
              clientKind,
              limit,
              params.agent,
              ranges
            ),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle, ranges) => {
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
              ...(batches.length === 1 ? { ranges } : {}),
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
      if (!subscription.watching) {
        return
      }
      recordMobileViewOpened(
        { clientKind, pairedDeviceId },
        {
          surface: 'chat',
          viewKey: `nativeChat:${params.agent}:${params.sessionId}`,
          agent: () => params.agent
        }
      )
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
