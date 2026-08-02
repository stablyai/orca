import { z } from 'zod'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  MOBILE_NATIVE_CHAT_MAX_WINDOW,
  sanitizeAppendForClient,
  windowForClient,
  type AuthorizedNativeChatPayloadSession
} from '../../../native-chat/mobile-payload-bounds'
import { readNativeChatTextBlock } from '../../../native-chat/transcript-record-reader'
import {
  nativeChatTextDigest,
  nativeChatTextRetrievalCapabilities
} from '../../../native-chat/text-retrieval-capabilities'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript
} from '../../../native-chat/transcript-watch'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'

// Why: native chat renders an agent's own transcript (Claude/Codex JSONL). The
// desktop reaches the readers via Electron IPC; mobile/web clients reach the
// same pure readers through these runtime RPC methods so the native chat view
// works over the paired connection, not just in the desktop renderer.

const NativeChatSession = z.object({
  agent: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing agent'))
    .transform((v) => v as AgentType),
  sessionId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing session id')),
  // How many of the most-recent messages to return. Clients start small for a
  // fast first paint and raise it to page older history in as the user scrolls.
  // Clamp (don't reject) a limit past the max window so a client paging beyond it
  // gets the capped tail and pagination stops cleanly — a hard `.max` rejection
  // would fail the read and stall "load earlier" at the boundary.
  limit: z
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  // Optional client-supplied cleanup token. When present, the subscribe handler
  // keys the fs-watcher cleanup under it so registration and unsubscribe derive
  // from the SAME token (back-compat: falls back to `agent:sessionId` when absent,
  // which is exactly what existing mobile clients rely on).
  subscriptionId: z.string().min(1).optional(),
  // Authoritative transcript path from the agent hook (providerSession), used to
  // locate the file directly when the session id no longer names it (recent
  // Claude Code). Optional for back-compat with older clients.
  transcriptPath: z.string().min(1).optional(),
  beforeOffset: z.number().int().nonnegative().optional()
})

const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})

const NativeChatTextBlockRequest = z.object({
  capability: z.string().min(32).max(128)
})

const FULL_TEXT_UNAVAILABLE = 'Full message unavailable'

function capabilityOwner(context: RpcContext): string {
  if (context.pairedDeviceId) {
    return `paired:${context.pairedDeviceId}`
  }
  if (context.clientId) {
    return `client:${context.clientId}`
  }
  if (context.connectionId) {
    return `connection:${context.connectionId}`
  }
  return 'local'
}

function authorizeSession(
  params: Pick<z.infer<typeof NativeChatSession>, 'agent' | 'sessionId' | 'transcriptPath'>,
  context: RpcContext
): AuthorizedNativeChatPayloadSession | null {
  const remote =
    context.clientKind !== undefined ||
    context.pairedDeviceId !== undefined ||
    context.clientId !== undefined ||
    context.connectionId !== undefined
  const authorization = remote
    ? context.runtime.authorizeNativeChatSession(
        params.agent,
        params.sessionId,
        params.transcriptPath
      )
    : params.transcriptPath
      ? { transcriptPath: params.transcriptPath }
      : {}
  return authorization
    ? {
        owner: capabilityOwner(context),
        agent: params.agent,
        sessionId: params.sessionId,
        ...(authorization.transcriptPath ? { transcriptPath: authorization.transcriptPath } : {})
      }
    : null
}

export const NATIVE_CHAT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'nativeChat.readSession',
    params: NativeChatSession,
    handler: async (params, context) => {
      const session = authorizeSession(params, context)
      if (!session) {
        return { error: 'Transcript unavailable' }
      }
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const result = await readNativeChatTranscriptTail({
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: session.transcriptPath,
        limit,
        beforeOffset: params.beforeOffset
      })
      return 'messages' in result
        ? {
            messages: windowForClient(result.messages, context.clientKind, session, limit),
            hasMore: result.hasMore,
            beforeOffset: result.beforeOffset,
            ...(result.lifecycle ? { lifecycle: result.lifecycle } : {})
          }
        : result
    }
  }),
  defineMethod({
    name: 'nativeChat.readTextBlock',
    params: NativeChatTextBlockRequest,
    handler: async (params, context) => {
      const grant = nativeChatTextRetrievalCapabilities.redeem(
        params.capability,
        capabilityOwner(context)
      )
      if (!grant) {
        return { error: FULL_TEXT_UNAVAILABLE }
      }
      const authorization = context.runtime.authorizeNativeChatSession(
        grant.agent,
        grant.sessionId,
        grant.transcriptPath
      )
      if (!authorization) {
        return { error: FULL_TEXT_UNAVAILABLE }
      }
      const result = await readNativeChatTextBlock({
        agent: grant.agent,
        sessionId: grant.sessionId,
        transcriptPath: authorization.transcriptPath,
        messageId: grant.messageId,
        recordOffset: grant.recordOffset,
        blockIndex: grant.blockIndex
      })
      return 'text' in result &&
        result.text.length === grant.originalChars &&
        nativeChatTextDigest(result.text) === grant.digest
        ? result
        : { error: FULL_TEXT_UNAVAILABLE }
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    params: NativeChatSession,
    handler: async (params, context, emit) => {
      const { runtime, connectionId, clientKind } = context
      const session = authorizeSession(params, context)
      if (!session) {
        emit({ type: 'snapshot', messages: [], hasMore: false, error: 'Transcript unavailable' })
        return
      }
      let closed = false
      let unsubscribe = (): void => {}
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
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          emit({ type: 'end' })
        },
        connectionId
      )
      if (closed) {
        return
      }
      const subscription = await subscribeNativeChatTranscript({
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: session.transcriptPath,
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle) => {
          const currentSession = authorizeSession(params, context)
          if (closed || !currentSession) {
            return
          }
          // Forward an initial-drain error so a watching client's first frame carries it
          // instead of stranding the view at 'loading' when the read keeps throwing.
          emit({
            type: 'snapshot',
            messages: windowForClient(messages, clientKind, currentSession, limit),
            hasMore,
            beforeOffset,
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onReplace: (messages, hasMore, beforeOffset, lifecycle) => {
          const currentSession = authorizeSession(params, context)
          if (closed || !currentSession) {
            return
          }
          emit({
            type: 'replacement',
            messages: windowForClient(messages, clientKind, currentSession, limit),
            hasMore,
            beforeOffset,
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle) => {
          const currentSession = authorizeSession(params, context)
          if (closed || !currentSession) {
            return
          }
          emit({
            type: 'appended',
            messages: sanitizeAppendForClient(messages, clientKind, currentSession),
            ...(lifecycle ? { lifecycle } : {})
          })
        }
      })
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
