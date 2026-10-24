// OMP history is a tree, but this stateless decoder renders file order, including abandoned branches.
// Correct branch selection requires state across records.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import type { AgentSessionTokenUsage } from '../../shared/agent-session-context-usage'
import { buildImageDataUri } from '../../shared/image-data-uri'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

export function decodeOmpTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (
    !record ||
    (record.type !== 'message' && record.type !== 'custom_message' && record.type !== 'compaction')
  ) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = parseTimestamp(record.timestamp)

  if (record.type === 'compaction') {
    // Compaction invalidates earlier context measurements.
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
      timestamp,
      source: 'transcript'
    }
  }

  if (record.type === 'custom_message') {
    // Match OMP visibility: undisplayed custom messages are hidden extension state.
    const customBlocks = record.display === true ? ompContentBlocks(record.content) : []
    return customBlocks.length === 0
      ? null
      : { id, role: 'system', blocks: customBlocks, timestamp, source: 'transcript' }
  }

  const message = asRecord(record.message)
  if (!message) {
    return null
  }
  const role = extractString(message.role)

  if (role === 'toolResult') {
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output: toolResultOutput(message.content),
          ...(message.isError === true ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  if (role === 'bashExecution' || role === 'pythonExecution') {
    // Execution cells have no content array; render invocation/output as a collapsible tool turn.
    return {
      id,
      role: 'tool',
      blocks: ompExecutionBlocks(role, message),
      timestamp,
      source: 'transcript'
    }
  }

  if (role === 'fileMention') {
    // Render mentioned paths only; embedded auto-read file contents would bury the conversation.
    const paths = ompFileMentionPaths(message.files)
    return paths.length === 0
      ? null
      : {
          id,
          role: 'system',
          blocks: [{ type: 'text', text: paths.map((path) => `@${path}`).join('\n') }],
          timestamp,
          source: 'transcript'
        }
  }

  // Pre-v3 custom/hookMessage rows use the same display gate as current custom_message rows.
  if ((role === 'custom' || role === 'hookMessage') && message.display !== true) {
    return null
  }
  const blocks = ompContentBlocks(message.content)
  if (blocks.length === 0) {
    // Empty aborted messages still need interruption status; preserve any partial content otherwise.
    return role === 'assistant' && message.stopReason === 'aborted'
      ? {
          id,
          role: 'system',
          blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
          timestamp,
          source: 'transcript'
        }
      : null
  }
  if (role === 'assistant') {
    return {
      id,
      role: 'assistant',
      blocks,
      timestamp,
      source: 'transcript',
      ...ompServing(message)
    }
  }
  return { id, role: role === 'user' ? 'user' : 'system', blocks, timestamp, source: 'transcript' }
}

function ompServing(
  message: Record<string, unknown>
): Pick<NativeChatMessage, 'model' | 'provider' | 'usage'> {
  const model = extractString(message.model)
  const provider = extractString(message.provider)
  // Match OMP’s context gauge, which excludes failed/aborted reply accounting.
  const usage =
    message.stopReason === 'aborted' || message.stopReason === 'error'
      ? null
      : ompTokenUsage(message.usage)
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(usage ? { usage } : {})
  }
}

function ompTokenUsage(value: unknown): AgentSessionTokenUsage | null {
  const usage = asRecord(value)
  if (!usage) {
    return null
  }
  return {
    inputTokens: tokenCount(usage.input),
    cacheCreationInputTokens: tokenCount(usage.cacheWrite),
    cacheReadInputTokens: tokenCount(usage.cacheRead),
    outputTokens: tokenCount(usage.output)
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function ompExecutionBlocks(
  role: 'bashExecution' | 'pythonExecution',
  message: Record<string, unknown>
): NativeChatBlock[] {
  const isBash = role === 'bashExecution'
  // Preserve whitespace meaningful in source/output; extractString trims it.
  const source = isBash ? message.command : message.code
  const output = message.output
  // JSON omits undefined exitCode on cancellation; cancelled must distinguish it from success.
  const failed =
    message.cancelled === true || (typeof message.exitCode === 'number' && message.exitCode !== 0)
  return [
    {
      type: 'tool-call',
      name: isBash ? 'bash' : 'python',
      input: typeof source === 'string' ? source : ''
    },
    {
      type: 'tool-result',
      output: typeof output === 'string' ? output : '',
      ...(failed ? { isError: true } : {})
    }
  ]
}

function ompFileMentionPaths(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return []
  }
  const paths: string[] = []
  for (const file of files) {
    const path = extractString(asRecord(file)?.path)
    if (path) {
      paths.push(path)
    }
  }
  return paths
}

function ompContentBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    const block = ompContentBlock(asRecord(item))
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

function ompContentBlock(record: Record<string, unknown> | null): NativeChatBlock | null {
  if (!record) {
    return null
  }
  switch (record.type) {
    case 'text': {
      const text = extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'thinking': {
      const text = extractString(record.thinking) ?? extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'toolCall': {
      const name = extractString(record.name) ?? 'tool'
      return { type: 'tool-call', name, input: record.arguments }
    }
    case 'image': {
      const data = extractString(record.data)
      const url =
        data && !data.startsWith('blob:')
          ? buildImageDataUri(extractString(record.mimeType) ?? undefined, data)
          : null
      return url ? { type: 'image-ref', url } : null
    }
    default:
      return null
  }
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
