import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { TranscriptByteRange } from '../../../../../shared/native-chat/transcript/transcript-byte-range'
import type { NativeChatTranscriptPage } from '../../../../../shared/native-chat/transcript/streaming/native-chat-transcript-frames'
import { resolveNativeChatTranscriptAgent } from '../../../../../shared/native-chat/native-chat-agent-support'
import {
  MOBILE_NATIVE_CHAT_MAX_WINDOW,
  type NativeChatResumePoint
} from '../../../../../shared/rpc-contract/native-chat/native-chat-params'
import type { RpcContext } from '../../core'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'
import { boundNativeChatRpcPageByBytes } from './native-chat-rpc-page-bounds'

export const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40

function sanitizeMessage(
  message: NativeChatMessage,
  clientKind: RpcContext['clientKind']
): NativeChatMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => sanitizeNativeChatRpcBlock(block, clientKind))
  }
}

export function sanitizeAppendForClient(
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

export function pageForClient(
  messages: readonly NativeChatMessage[],
  hasMore: boolean,
  beforeOffset: number,
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  agent?: string,
  ranges?: TranscriptByteRange[]
): NativeChatTranscriptPage {
  const isOpenCode = resolveNativeChatTranscriptAgent(agent) === 'opencode'
  const sanitized = (isOpenCode ? messages : windowTranscript(messages, limit)).map((message) =>
    sanitizeMessage(message, clientKind)
  )
  return isOpenCode
    ? boundNativeChatRpcPageByBytes(sanitized, hasMore, beforeOffset)
    : {
        messages: sanitized,
        hasMore,
        beforeOffset,
        ...(sanitized.length === messages.length ? { ranges } : {})
      }
}

/** Where the first page starts for a client holding `resumeAfter`; its offset and timestamp catch a rewritten file. */
export function resumeIndex(
  messages: readonly NativeChatMessage[],
  resumeAfter: NativeChatResumePoint | undefined,
  agent: string
): number {
  // OpenCode rows can change after they are written, so holding the newest says nothing about the rest.
  if (!resumeAfter || resolveNativeChatTranscriptAgent(agent) === 'opencode') {
    return -1
  }
  return messages.findLastIndex(
    (message) =>
      message.id === resumeAfter.id &&
      message.transcriptOrder === resumeAfter.transcriptOrder &&
      (message.timestamp ?? null) === resumeAfter.timestamp
  )
}
