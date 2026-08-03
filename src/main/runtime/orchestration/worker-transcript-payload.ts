import { createHash } from 'node:crypto'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'

export const DEFAULT_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 40
export const MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 50
const MAX_WORKER_TRANSCRIPT_BLOCKS = 6
const MAX_WORKER_TRANSCRIPT_BLOCK_CHARS = 1_200
const MAX_WORKER_TRANSCRIPT_INPUT_ITEMS = 20
const MAX_WORKER_TRANSCRIPT_INPUT_NODES = 100
const MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES = 512 * 1024
const TRUNCATION_MARKER = '\n… (truncated)'
const DISPATCH_CAPABILITY_PATTERN = /\bdcap_[A-Za-z0-9_-]{20,}\b/g
const DISPATCH_CAPABILITY_REDACTION = '[dispatch capability redacted]'

export function clampWorkerTranscriptLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_WORKER_TRANSCRIPT_MESSAGE_LIMIT
  }
  return Math.min(Math.floor(limit!), MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT)
}

export function redactWorkerTerminalLines(lines: readonly string[]): {
  lines: string[]
  warnings: string[]
} {
  let redacted = false
  const bounded = lines.map((line) => {
    const result = replaceDispatchCapabilities(line)
    redacted ||= result.redacted
    return result.value
  })
  return {
    lines: bounded,
    warnings: redacted ? ['Dispatch capability tokens were redacted from terminal output.'] : []
  }
}

export function boundWorkerTranscriptMessages(
  messages: readonly NativeChatMessage[],
  transcriptPath?: string
): {
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
} {
  const warnings = new Set<string>()
  const bounded: NativeChatMessage[] = []
  let bytes = 2
  for (const message of messages) {
    const next = boundMessage(message, transcriptPath, warnings)
    const serializedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8') + 1
    if (bounded.length > 0 && bytes + serializedBytes > MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES) {
      warnings.add('Transcript response was clipped to the wire-size limit.')
      return { messages: bounded, limited: true, warnings: [...warnings] }
    }
    bounded.push(next)
    bytes += serializedBytes
  }
  return { messages: bounded, limited: false, warnings: [...warnings] }
}

function boundMessage(
  message: NativeChatMessage,
  transcriptPath: string | undefined,
  warnings: Set<string>
): NativeChatMessage {
  const blocks = message.blocks.slice(0, MAX_WORKER_TRANSCRIPT_BLOCKS)
  if (blocks.length < message.blocks.length) {
    warnings.add('Some transcript blocks were omitted from oversized messages.')
  }
  return {
    ...message,
    id: boundIdentifier(message.id, transcriptPath, warnings),
    ...(message.turnId
      ? { turnId: boundIdentifier(message.turnId, transcriptPath, warnings) }
      : {}),
    blocks: blocks.map((block) => boundBlock(block, warnings))
  }
}

function boundBlock(block: NativeChatBlock, warnings: Set<string>): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: clipText(block.text, warnings) }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: clipText(block.output, warnings) }
  }
  if (block.type === 'tool-call') {
    const budget = {
      remaining: MAX_WORKER_TRANSCRIPT_BLOCK_CHARS,
      nodes: MAX_WORKER_TRANSCRIPT_INPUT_NODES
    }
    return {
      ...block,
      name: clipMetadata(block.name, warnings),
      input: boundToolInput(block.input, budget, 0, warnings)
    }
  }
  if (block.path || (block.url && isLocalFileLocator(block.url))) {
    warnings.add('Local image paths were omitted from transcript output.')
    return {
      type: 'image-ref',
      ...(block.alt ? { alt: clipText(block.alt, warnings) } : {})
    }
  }
  return {
    ...block,
    ...(block.url ? { url: clipMetadata(block.url, warnings) } : {}),
    ...(block.alt ? { alt: clipText(block.alt, warnings) } : {})
  }
}

function boundIdentifier(
  value: string,
  transcriptPath: string | undefined,
  warnings: Set<string>
): string {
  if (transcriptPath && value.includes(transcriptPath)) {
    warnings.add('Transcript-backed message identifiers were made opaque.')
    return `worker-message-${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`
  }
  return clipMetadata(value, warnings)
}

function isLocalFileLocator(value: string): boolean {
  return (
    /^file:/i.test(value) ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\\\')
  )
}

function clipMetadata(value: string, warnings: Set<string>): string {
  const redacted = redactSensitiveText(value, warnings)
  if (redacted.length <= 512) {
    return redacted
  }
  warnings.add('Oversized transcript metadata was clipped.')
  return redacted.slice(0, 512)
}

function clipText(value: string, warnings: Set<string>): string {
  const redacted = redactSensitiveText(value, warnings)
  if (redacted.length <= MAX_WORKER_TRANSCRIPT_BLOCK_CHARS) {
    return redacted
  }
  warnings.add('Oversized transcript text was clipped.')
  return `${redacted.slice(0, MAX_WORKER_TRANSCRIPT_BLOCK_CHARS)}${TRUNCATION_MARKER}`
}

function boundToolInput(
  value: unknown,
  budget: { remaining: number; nodes: number },
  depth: number,
  warnings: Set<string>
): unknown {
  budget.nodes--
  if (budget.nodes < 0 || budget.remaining <= 0) {
    warnings.add('Oversized tool input was clipped.')
    return '… (truncated)'
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value, warnings)
    const length = Math.min(redacted.length, budget.remaining)
    budget.remaining -= length
    if (length < redacted.length) {
      warnings.add('Oversized tool input was clipped.')
      return `${redacted.slice(0, length)}… (truncated)`
    }
    return redacted
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (depth >= 5) {
    warnings.add('Deep tool input was clipped.')
    return '… (truncated)'
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_WORKER_TRANSCRIPT_INPUT_ITEMS)
      .map((item) => boundToolInput(item, budget, depth + 1, warnings))
    if (value.length > MAX_WORKER_TRANSCRIPT_INPUT_ITEMS) {
      warnings.add('Oversized tool input was clipped.')
      result.push('… (truncated)')
    }
    return result
  }
  const result: Record<string, unknown> = Object.create(null)
  let count = 0
  for (const [rawKey, entry] of Object.entries(value)) {
    if (count >= MAX_WORKER_TRANSCRIPT_INPUT_ITEMS || budget.remaining <= 0) {
      warnings.add('Oversized tool input was clipped.')
      result['…'] = 'truncated'
      break
    }
    const redactedKey = redactSensitiveText(rawKey, warnings)
    const key = redactedKey.slice(0, Math.min(redactedKey.length, budget.remaining, 128))
    budget.remaining -= key.length
    result[key] = boundToolInput(entry, budget, depth + 1, warnings)
    count++
  }
  return result
}

function redactSensitiveText(value: string, warnings: Set<string>): string {
  const result = replaceDispatchCapabilities(value)
  if (!result.redacted) {
    return result.value
  }
  warnings.add('Dispatch capability tokens were redacted from transcript output.')
  return result.value
}

function replaceDispatchCapabilities(value: string): { value: string; redacted: boolean } {
  DISPATCH_CAPABILITY_PATTERN.lastIndex = 0
  const redacted = DISPATCH_CAPABILITY_PATTERN.test(value)
  DISPATCH_CAPABILITY_PATTERN.lastIndex = 0
  return {
    value: redacted
      ? value.replace(DISPATCH_CAPABILITY_PATTERN, DISPATCH_CAPABILITY_REDACTION)
      : value,
    redacted
  }
}
