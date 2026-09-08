import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_READ_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS
} from '../../../../shared/mobile-web/native-chat-operation-contract'

const MARKER = '\n… (truncated)'
const TOOL_CALL_STATES = new Set(['running', 'completed', 'failed'])
// Every key the page's read result and stream event schemas declare, and nothing else.
const TRANSCRIPT_KEYS = [
  'type',
  'messages',
  'hasMore',
  'beforeOffset',
  'error',
  'pending',
  'lifecycle'
] as const
const MESSAGE_KEYS = ['id', 'role', 'blocks', 'timestamp', 'source', 'turnId'] as const
const omittedBlock = { type: 'text', text: MARKER }
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/**
 * Reshapes a host transcript into what the page's read schema declares.
 *
 * The host sanitizer caps text blocks at 64 KiB, bounds neither block count nor identifier length,
 * and carries host-only detail (`providerFrame`, `editPatch`) the page never names. The page parses
 * the relayed payload with the plain strict schema, and a parse failure there is permanent:
 * `invalid_message` is not retryable and nothing re-subscribes. So the host emits page-shaped
 * blocks and page-sized content, then bounds the whole payload to the event budget.
 */
export function boundMobileWebNativeChatRead(source: unknown): unknown {
  // Always first: the byte budget only engages above 512 KiB, and every page-contract overrun is
  // silent well under it.
  const value = pageShapedTranscript(source)
  if (byteLength(value) <= MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES) {
    return value
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('too_large')
  }

  // Keep every message and the host cursor: dropping messages would skip history on the next read.
  const metadata = value.messages.map((message) =>
    isRecord(message) && Array.isArray(message.blocks) ? { ...message, blocks: [] } : message
  )
  const remaining =
    MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES - byteLength({ ...value, messages: metadata })
  const allowance = Math.floor(remaining / Math.max(1, metadata.length))
  if (allowance < byteLength([omittedBlock])) {
    throw new Error('too_large')
  }
  return {
    ...value,
    messages: value.messages.map((message) =>
      isRecord(message) && Array.isArray(message.blocks)
        ? { ...message, blocks: boundBlocks(message.blocks, allowance) }
        : message
    )
  }
}

function pageShapedTranscript(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return value
  }
  return {
    ...declared(value, TRANSCRIPT_KEYS),
    messages: value.messages.slice(0, MOBILE_WEB_NATIVE_CHAT_READ_LIMIT).map(pageShapedMessage)
  }
}

function declared(value: Record<string, unknown>, keys: readonly string[]) {
  const shaped: Record<string, unknown> = {}
  for (const key of keys) {
    if (value[key] !== undefined) {
      shaped[key] = value[key]
    }
  }
  return shaped
}

/** Ids are clipped rather than dropped: losing the message loses history the page cannot ask for
 *  again, and the clip is deterministic, so read and subscribe still agree on the dedup key. */
function pageShapedMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return {
    ...declared(value, MESSAGE_KEYS),
    ...clippedIdentifier(value, 'id'),
    ...clippedIdentifier(value, 'turnId'),
    ...(Array.isArray(value.blocks) ? { blocks: pageShapedBlocks(value.blocks) } : {})
  }
}

function clippedIdentifier(message: Record<string, unknown>, key: 'id' | 'turnId') {
  const value = message[key]
  return typeof value === 'string' &&
    value.length > MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS
    ? { [key]: value.slice(0, MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS) }
    : {}
}

function pageShapedBlocks(blocks: unknown[]): unknown[] {
  const shaped = blocks.map(pageShapedBlock).filter((block) => block !== null)
  return shaped.length <= MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT
    ? shaped
    : [...shaped.slice(0, MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT - 1), omittedBlock]
}

/** Each arm names every field the page declares, so host-only detail never reaches a strict parse.
 *  A block the page cannot name is dropped rather than failing the message around it. */
function pageShapedBlock(value: unknown): unknown {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'text') {
    return typeof value.text === 'string' ? { type: 'text', text: clippedProse(value.text) } : null
  }
  if (value.type === 'tool-result') {
    return typeof value.output === 'string'
      ? {
          type: 'tool-result',
          output: clippedProse(value.output),
          ...(value.isError === undefined ? {} : { isError: value.isError })
        }
      : null
  }
  if (value.type === 'tool-call') {
    return typeof value.name === 'string' && value.name.length > 0
      ? {
          type: 'tool-call',
          name: clippedLabel(value.name),
          input: value.input,
          ...(TOOL_CALL_STATES.has(value.state as string) ? { state: value.state } : {})
        }
      : null
  }
  if (value.type !== 'image-ref') {
    return null
  }
  return {
    type: 'image-ref',
    ...boundedReference(value, 'path', MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS),
    ...boundedReference(value, 'url', MOBILE_WEB_NATIVE_CHAT_IMAGE_REF_MAX_CHARACTERS),
    ...boundedReference(value, 'alt', MOBILE_WEB_NATIVE_CHAT_IMAGE_ALT_MAX_CHARACTERS)
  }
}

/** Displayed content: the reader is told it was cut. */
function clippedProse(value: string): string {
  if (value.length <= MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS) {
    return value
  }
  const head = value.slice(0, MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS - MARKER.length)
  return `${head}${MARKER}`
}

/** A short label, so a marker inside it would read as part of the name. */
function clippedLabel(value: string): string {
  return value.length > MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS
    ? value.slice(0, MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS)
    : value
}

/** A clipped reference is a wrong reference the page would try to resolve; absent renders a
 *  placeholder instead. */
function boundedReference(block: Record<string, unknown>, key: string, maximum: number) {
  const value = block[key]
  return typeof value === 'string' && value.length <= maximum ? { [key]: value } : {}
}

function boundBlocks(blocks: unknown[], allowance: number): unknown[] {
  if (byteLength(blocks) <= allowance) {
    return blocks
  }
  let cap = MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS
  while (cap >= 0) {
    const projected = blocks.map((block) => {
      if (!isRecord(block)) {
        return block
      }
      const field = block.type === 'text' ? 'text' : block.type === 'tool-result' ? 'output' : null
      if (!field || typeof block[field] !== 'string' || block[field].length <= cap) {
        return block
      }
      return { ...block, [field]: block[field].slice(0, cap) + MARKER }
    })
    if (byteLength(projected) <= allowance) {
      return projected
    }
    if (cap === 0) {
      // Oversized tools/future blocks remain visibly truncated, without a closed block schema.
      const bounded: unknown[] = []
      let used = 2 + byteLength(omittedBlock) + 1
      for (const block of projected) {
        const bytes = byteLength(block) + 1
        if (used + bytes > allowance) {
          break
        }
        bounded.push(block)
        used += bytes
      }
      return [...bounded, omittedBlock]
    }
    cap = Math.floor(cap / 2)
  }
  return [omittedBlock]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
