import { z } from 'zod'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentType } from '../../../../shared/native-chat-types'
import { readNativeChatTranscriptCached } from '../../../native-chat/transcript-read-cache'
import { subscribeNativeChatTranscript } from '../../../native-chat/transcript-watch'
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
  transcriptPath: z.string().min(1).optional()
})

const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})

// Why: a long agent session can hold thousands of turns (with full tool I/O).
// Shipping all of them over the paired connection and rendering them at once
// freezes the mobile app, so the runtime RPC windows to the most recent slice —
// the conversation tail is what the chat view shows first. The desktop IPC path
// is unaffected (it reads locally with a virtualized list).
// Small first page for a fast initial paint; the client raises `limit` to load
// older history as the user scrolls back.
const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40
const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000
// Why: a single tool result (a big file read, a long diff) can be hundreds of KB.
// The mobile view only previews block bodies, so truncate them on the wire to
// keep the payload small; the marker tells the user content was clipped.
const MOBILE_BLOCK_CHAR_CAP = 4000
const TRUNCATION_MARKER = '\n… (truncated)'

function clip(text: string): string {
  return text.length > MOBILE_BLOCK_CHAR_CAP
    ? text.slice(0, MOBILE_BLOCK_CHAR_CAP) + TRUNCATION_MARKER
    : text
}

function clipBlock(block: NativeChatBlock): NativeChatBlock {
  if (block.type === 'text') {
    return block.text.length > MOBILE_BLOCK_CHAR_CAP ? { ...block, text: clip(block.text) } : block
  }
  if (block.type === 'tool-result') {
    return block.output.length > MOBILE_BLOCK_CHAR_CAP
      ? { ...block, output: clip(block.output) }
      : block
  }
  return block
}

function sanitizeMessage(message: NativeChatMessage): NativeChatMessage {
  return { ...message, blocks: message.blocks.map(clipBlock) }
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

/** Apply the windowed slice plus, for `mobile` clients only, oversized-block
 *  char truncation. Web/desktop (`runtime`, or undefined for in-process callers)
 *  are full-class surfaces and pass block bodies through untruncated — matching
 *  the desktop IPC path, which never clips. */
function windowForClient(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
): NativeChatMessage[] {
  const windowed = windowTranscript(messages, limit)
  return clientKind === 'mobile' ? windowed.map(sanitizeMessage) : windowed
}

export const NATIVE_CHAT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'nativeChat.readSession',
    params: NativeChatSession,
    handler: async (params, { clientKind }) => {
      const result = await readNativeChatTranscriptCached(
        params.agent,
        params.sessionId,
        params.transcriptPath
      )
      // Window to the conversation tail (all clients); clip blocks for mobile only.
      return 'messages' in result
        ? { messages: windowForClient(result.messages, clientKind, params.limit) }
        : result
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    params: NativeChatSession,
    handler: async (params, { runtime, connectionId, clientKind }, emit) => {
      let closed = false
      let unsubscribe = (): void => {}
      // Why: the subscriber seeds its read offset at 0, so the first drain emits
      // the whole transcript and later drains emit only appended turns. The first
      // batch is windowed to the tail (a full transcript would freeze mobile);
      // later incremental batches are smaller than the window so they pass through.
      // Clients merge by message id, so the initial windowed batch doubles as the
      // snapshot. Keyed by the client-supplied subscriptionId when present so
      // registration and unsubscribe derive from the same token; otherwise by
      // agent:sessionId, which is exactly the token existing mobile clients send to
      // unsubscribe (no wire break).
      const cleanupToken = params.subscriptionId ?? `${params.agent}:${params.sessionId}`
      const subscriptionId = `nativeChat:${connectionId ?? 'local'}:${cleanupToken}`
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
        transcriptPath: params.transcriptPath,
        onAppend: (messages) => {
          if (closed) {
            return
          }
          emit({ type: 'appended', messages: windowForClient(messages, clientKind) })
        }
      })
      // The connection may have closed while the file was being resolved.
      if (closed) {
        subscription.unsubscribe()
        return
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
