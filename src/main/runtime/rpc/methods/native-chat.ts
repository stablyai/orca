import { z } from 'zod'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentType } from '../../../../shared/native-chat-types'
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
const MOBILE_TOOL_INPUT_ITEMS_CAP = 20
const MOBILE_TOOL_INPUT_NODE_CAP = 100
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
  if (block.type === 'tool-call') {
    const budget = { remaining: MOBILE_BLOCK_CHAR_CAP, nodes: MOBILE_TOOL_INPUT_NODE_CAP }
    return { ...block, input: sanitizeToolInput(block.input, budget, 0) }
  }
  return block
}

function sanitizeToolInput(
  value: unknown,
  budget: { remaining: number; nodes: number },
  depth: number
): unknown {
  budget.nodes--
  if (budget.nodes < 0 || budget.remaining <= 0) {
    return '… (truncated)'
  }
  if (typeof value === 'string') {
    const length = Math.min(value.length, budget.remaining)
    budget.remaining -= length
    return length < value.length ? `${value.slice(0, length)}… (truncated)` : value
  }
  if (!value || typeof value !== 'object' || depth >= 5) {
    return value && typeof value === 'object' ? '… (truncated)' : value
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MOBILE_TOOL_INPUT_ITEMS_CAP)
      .map((item) => sanitizeToolInput(item, budget, depth + 1))
    if (value.length > MOBILE_TOOL_INPUT_ITEMS_CAP) {
      result.push('… (truncated)')
    }
    return result
  }
  const result: Record<string, unknown> = {}
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue
    }
    if (count >= MOBILE_TOOL_INPUT_ITEMS_CAP || budget.remaining <= 0) {
      result['…'] = 'truncated'
      break
    }
    let boundedKey = key.slice(0, Math.min(key.length, budget.remaining, 128))
    // Why: sibling keys sharing a >=128-char (or budget-truncated) prefix collapse
    // to the same bounded key; suffix collisions so neither field is silently lost.
    if (Object.prototype.hasOwnProperty.call(result, boundedKey)) {
      boundedKey = `${boundedKey}~${count}`
    }
    budget.remaining -= boundedKey.length
    result[boundedKey] = sanitizeToolInput(
      (value as Record<string, unknown>)[key],
      budget,
      depth + 1
    )
    count++
  }
  return result
}

function sanitizeMessage(message: NativeChatMessage): NativeChatMessage {
  return { ...message, blocks: message.blocks.map(clipBlock) }
}

function sanitizeAppendForClient(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind']
): NativeChatMessage[] {
  return clientKind === 'mobile' ? messages.map(sanitizeMessage) : messages.slice()
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
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const result = await readNativeChatTranscriptTail({
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: params.transcriptPath,
        limit,
        beforeOffset: params.beforeOffset
      })
      return 'messages' in result
        ? {
            messages: windowForClient(result.messages, clientKind, limit),
            hasMore: result.hasMore,
            beforeOffset: result.beforeOffset,
            ...(result.lifecycle ? { lifecycle: result.lifecycle } : {})
          }
        : result
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    params: NativeChatSession,
    handler: async (params, { runtime, connectionId, clientKind }, emit) => {
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
        transcriptPath: params.transcriptPath,
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle) => {
          if (closed) {
            return
          }
          // Forward an initial-drain error so a watching client's first frame carries it
          // instead of stranding the view at 'loading' when the read keeps throwing.
          emit({
            type: 'snapshot',
            messages: windowForClient(messages, clientKind, limit),
            hasMore,
            beforeOffset,
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onReplace: (messages, hasMore, beforeOffset, lifecycle) => {
          if (closed) {
            return
          }
          emit({
            type: 'replacement',
            messages: windowForClient(messages, clientKind, limit),
            hasMore,
            beforeOffset,
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle) => {
          if (closed) {
            return
          }
          emit({
            type: 'appended',
            messages: sanitizeAppendForClient(messages, clientKind),
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
