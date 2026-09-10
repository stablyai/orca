import { createHash } from 'node:crypto'
import { normalizeSubagentState } from '../../../shared/native-chat-subagent-summary'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatSubagentState
} from '../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../../native-chat/subagent-entry-id-bounds'

export const DEFAULT_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 40
export const MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT = 50
const MAX_WORKER_TRANSCRIPT_BLOCKS = 6
const MAX_WORKER_TRANSCRIPT_BLOCK_CHARS = 1_200
const MAX_WORKER_TRANSCRIPT_INPUT_ITEMS = 20
const MAX_WORKER_TRANSCRIPT_INPUT_NODES = 100
// Matches the producer's per-group cap, so no group this build writes is clipped
// here. The bound stays because the journal schema declares no maximum and a
// remote host may run a build with a larger one.
const MAX_WORKER_TRANSCRIPT_SUBAGENTS = 64
// Message ids, turn ids, tool-call names and image urls, not only roster fields.
// Equal to `MAX_SUBAGENT_FIELD_CHARS` today, kept a separate literal so a
// roster-motivated change to that cap cannot silently move this one.
const MAX_WORKER_TRANSCRIPT_METADATA_CHARS = 512
const MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES = 512 * 1024
const TRUNCATION_MARKER = '\n… (truncated)'
const DISPATCH_CAPABILITY_PATTERN = /\bdcap_[A-Za-z0-9_-]{20,}\b/g
const DISPATCH_CAPABILITY_REDACTION = '[dispatch capability redacted]'

type TranscriptBoundState = {
  warnings: Set<string>
  clipped: boolean
}

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
  const state: TranscriptBoundState = { warnings: new Set<string>(), clipped: false }
  const bounded: NativeChatMessage[] = []
  let bytes = 2
  for (const message of messages) {
    const next = boundMessage(message, transcriptPath, state)
    const serializedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8') + 1
    if (bounded.length > 0 && bytes + serializedBytes > MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES) {
      markClipped(state, 'Transcript response was clipped to the wire-size limit.')
      return { messages: bounded, limited: true, warnings: [...state.warnings] }
    }
    bounded.push(next)
    bytes += serializedBytes
  }
  return { messages: bounded, limited: state.clipped, warnings: [...state.warnings] }
}

/**
 * The same per-message bounding, accumulated NEWEST-first.
 *
 * `boundWorkerTranscriptMessages` keeps the head, which is right for a forward page and wrong for
 * an archive: the evidence anyone reads a released worker back for is its final answer, so the
 * tail is what must survive the budget.
 */
export function boundWorkerTranscriptTail(
  messages: readonly NativeChatMessage[],
  maxBytes: number
): { messages: NativeChatMessage[]; limited: boolean; warnings: string[] } {
  const state: TranscriptBoundState = { warnings: new Set<string>(), clipped: false }
  const keptReversed: NativeChatMessage[] = []
  let bytes = 2
  let limited = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const next = boundMessage(messages[index]!, undefined, state)
    const serializedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8') + 1
    if (keptReversed.length > 0 && bytes + serializedBytes > maxBytes) {
      limited = true
      break
    }
    keptReversed.push(next)
    bytes += serializedBytes
  }
  keptReversed.reverse()
  return { messages: keptReversed, limited, warnings: [...state.warnings] }
}

function boundMessage(
  message: NativeChatMessage,
  transcriptPath: string | undefined,
  state: TranscriptBoundState
): NativeChatMessage {
  const blocks = message.blocks.slice(0, MAX_WORKER_TRANSCRIPT_BLOCKS)
  if (blocks.length < message.blocks.length) {
    markClipped(state, 'Some transcript blocks were omitted from oversized messages.')
  }
  return {
    ...message,
    id: boundIdentifier(message.id, transcriptPath, state),
    ...(message.turnId ? { turnId: boundIdentifier(message.turnId, transcriptPath, state) } : {}),
    blocks: blocks.map((block) => boundBlock(block, state))
  }
}

function boundBlock(block: NativeChatBlock, state: TranscriptBoundState): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: clipText(block.text, state) }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: clipText(block.output, state) }
  }
  if (block.type === 'tool-call') {
    const budget = {
      remaining: MAX_WORKER_TRANSCRIPT_BLOCK_CHARS,
      nodes: MAX_WORKER_TRANSCRIPT_INPUT_NODES
    }
    return {
      ...block,
      name: clipMetadata(block.name, state),
      input: boundToolInput(block.input, budget, 0, state)
    }
  }
  if (block.type === 'subagent-group') {
    const agents = block.agents.slice(0, MAX_WORKER_TRANSCRIPT_SUBAGENTS)
    if (agents.length < block.agents.length) {
      markClipped(state, 'Some subagents were omitted from oversized spawn groups.')
    }
    // Labels, ids and states come from provider-supplied strings, so they get the
    // same redaction and clipping every other piece of transcript metadata gets.
    return {
      ...block,
      groupId: clipMetadata(block.groupId, state),
      agents: agents.map((agent) => ({
        ...agent,
        id: boundEntryId(agent.id, state),
        label: clipMetadata(agent.label, state),
        state: clipSubagentState(agent.state, state)
      }))
    }
  }
  if (block.path || (block.url && isLocalFileLocator(block.url))) {
    markClipped(state, 'Local image paths were omitted from transcript output.')
    return {
      type: 'image-ref',
      ...(block.alt ? { alt: clipText(block.alt, state) } : {})
    }
  }
  return {
    ...block,
    ...(block.url ? { url: clipMetadata(block.url, state) } : {}),
    ...(block.alt ? { alt: clipText(block.alt, state) } : {})
  }
}

function boundIdentifier(
  value: string,
  transcriptPath: string | undefined,
  state: TranscriptBoundState
): string {
  if (transcriptPath && value.includes(transcriptPath)) {
    state.warnings.add('Transcript-backed message identifiers were made opaque.')
    return `worker-message-${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`
  }
  return clipMetadata(value, state)
}

function isLocalFileLocator(value: string): boolean {
  return (
    /^file:/i.test(value) ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\\\')
  )
}

/** A roster entry's id is the roster KEY, so it is redacted like other metadata
 *  but bounded with a digest rather than clipped: two ids sharing a 512-char
 *  head must not collapse onto one entry. */
function boundEntryId(value: string, state: TranscriptBoundState): string {
  const redacted = redactSensitiveText(value, state.warnings)
  const bounded = boundSubagentEntryId(redacted)
  if (bounded !== redacted) {
    markClipped(state, 'Oversized transcript metadata was clipped.')
  }
  return bounded
}

function clipMetadata(value: string, state: TranscriptBoundState): string {
  const redacted = redactSensitiveText(value, state.warnings)
  if (redacted.length <= MAX_WORKER_TRANSCRIPT_METADATA_CHARS) {
    return redacted
  }
  markClipped(state, 'Oversized transcript metadata was clipped.')
  return redacted.slice(0, MAX_WORKER_TRANSCRIPT_METADATA_CHARS)
}

/** `state` is an open string on the wire, so it takes the same bound. A value
 *  that had to be redacted or clipped names no state any build knows, which is
 *  exactly what `unverifiable` records. */
function clipSubagentState(
  value: NativeChatSubagentState,
  state: TranscriptBoundState
): NativeChatSubagentState {
  const clipped = clipMetadata(value, state)
  return clipped === value ? value : normalizeSubagentState(clipped)
}

function clipText(value: string, state: TranscriptBoundState): string {
  const redacted = redactSensitiveText(value, state.warnings)
  if (redacted.length <= MAX_WORKER_TRANSCRIPT_BLOCK_CHARS) {
    return redacted
  }
  markClipped(state, 'Oversized transcript text was clipped.')
  return `${redacted.slice(0, MAX_WORKER_TRANSCRIPT_BLOCK_CHARS)}${TRUNCATION_MARKER}`
}

function boundToolInput(
  value: unknown,
  budget: { remaining: number; nodes: number },
  depth: number,
  state: TranscriptBoundState
): unknown {
  budget.nodes--
  if (budget.nodes < 0 || budget.remaining <= 0) {
    markClipped(state, 'Oversized tool input was clipped.')
    return '… (truncated)'
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value, state.warnings)
    const length = Math.min(redacted.length, budget.remaining)
    budget.remaining -= length
    if (length < redacted.length) {
      markClipped(state, 'Oversized tool input was clipped.')
      return `${redacted.slice(0, length)}… (truncated)`
    }
    return redacted
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (depth >= 5) {
    markClipped(state, 'Deep tool input was clipped.')
    return '… (truncated)'
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_WORKER_TRANSCRIPT_INPUT_ITEMS)
      .map((item) => boundToolInput(item, budget, depth + 1, state))
    if (value.length > MAX_WORKER_TRANSCRIPT_INPUT_ITEMS) {
      markClipped(state, 'Oversized tool input was clipped.')
      result.push('… (truncated)')
    }
    return result
  }
  const result: Record<string, unknown> = Object.create(null)
  let count = 0
  for (const [rawKey, entry] of Object.entries(value)) {
    if (count >= MAX_WORKER_TRANSCRIPT_INPUT_ITEMS || budget.remaining <= 0) {
      markClipped(state, 'Oversized tool input was clipped.')
      result['…'] = 'truncated'
      break
    }
    const redactedKey = redactSensitiveText(rawKey, state.warnings)
    const key = redactedKey.slice(0, Math.min(redactedKey.length, budget.remaining, 128))
    if (key.length < redactedKey.length) {
      markClipped(state, 'Oversized tool input was clipped.')
    }
    budget.remaining -= key.length
    result[key] = boundToolInput(entry, budget, depth + 1, state)
    count++
  }
  return result
}

function markClipped(state: TranscriptBoundState, warning: string): void {
  state.clipped = true
  state.warnings.add(warning)
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
