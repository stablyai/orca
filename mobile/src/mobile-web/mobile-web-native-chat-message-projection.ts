import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_READ_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS,
  type MobileWebNativeChatMessage
} from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { sanitizeMobileWebNativeChatToolInput } from './mobile-web-native-chat-tool-input'

type Block = MobileWebNativeChatMessage['blocks'][number]

const TRUNCATION_MARKER = '\n… (truncated)'
const ROLES = new Set(['user', 'assistant', 'tool', 'reasoning', 'system'])
const SOURCES = new Set(['transcript', 'hook', 'scrape'])
const TOOL_CALL_STATES = new Set(['running', 'completed', 'failed'])

/**
 * Projects host transcript messages onto the page contract rather than validating against it.
 *
 * The host publishes content this wire has never carried — Claude's resolved edit hunks, a
 * structured provider frame, and text up to 64 KiB where the wire allows 4200 — and the shell used
 * to `.parse` its reply against a `.strict()` schema. Any one of those blanked the whole transcript
 * on `read` and permanently cancelled the stream on `subscribe`, while the native app, which reads
 * the same host method directly, showed the message fine.
 *
 * Fields no mobile component reads are dropped rather than widened: mobile renders edits through
 * `diffFromToolCall`, not through `editPatch`. Carrying one later is an additive shell->page field.
 */
export function projectMobileWebNativeChatMessages(
  value: unknown
): MobileWebNativeChatMessage[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.slice(0, MOBILE_WEB_NATIVE_CHAT_READ_LIMIT).flatMap((message) => {
    const projected = projectMessage(message)
    return projected ? [projected] : []
  })
}

function projectMessage(value: unknown): MobileWebNativeChatMessage | null {
  if (!isRecord(value)) {
    return null
  }
  const id = boundedIdentifier(value.id)
  const turnId = boundedIdentifier(value.turnId)
  if (!id || !isMember(ROLES, value.role) || !isMember(SOURCES, value.source)) {
    return null
  }
  const blocks = Array.isArray(value.blocks) ? value.blocks : []
  return {
    id,
    role: value.role as MobileWebNativeChatMessage['role'],
    blocks: blocks.slice(0, MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT).flatMap((block) => {
      const projected = projectBlock(block)
      return projected ? [projected] : []
    }),
    timestamp:
      typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
        ? value.timestamp
        : null,
    source: value.source as MobileWebNativeChatMessage['source'],
    ...(turnId ? { turnId } : {})
  }
}

function projectBlock(value: unknown): Block | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'text') {
    return typeof value.text === 'string'
      ? {
          type: 'text',
          text: clipped(value.text, MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS)
        }
      : null
  }
  if (value.type === 'tool-call') {
    const name = boundedText(value.name, MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS)
    return name
      ? {
          type: 'tool-call',
          name,
          input: sanitizeMobileWebNativeChatToolInput(value.input),
          ...(isMember(TOOL_CALL_STATES, value.state)
            ? { state: value.state as 'running' | 'completed' | 'failed' }
            : {})
        }
      : null
  }
  if (value.type === 'tool-result') {
    return typeof value.output === 'string'
      ? {
          type: 'tool-result',
          output: clipped(value.output, MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS),
          ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {})
        }
      : null
  }
  if (value.type !== 'image-ref') {
    return null
  }
  const path = boundedText(value.path, MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS)
  const url = boundedText(value.url, MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS)
  const alt = boundedText(value.alt, MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS)
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}

/** Clipped, never refused: the page showing a truncated message beats it showing none. */
function clipped(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined
}

/** Ids are dedup keys on both sides, so a clipped one is worse than a dropped message. */
function boundedIdentifier(value: unknown): string | undefined {
  return boundedText(value, MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS)
}

function isMember(members: ReadonlySet<string>, value: unknown): boolean {
  return typeof value === 'string' && members.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
