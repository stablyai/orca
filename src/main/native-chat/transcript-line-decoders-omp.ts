// omp (pi-agent) JSONL line → NativeChatMessage decoder.
//
// Conversation turns are `type: 'message'`; every other record type is session
// bookkeeping. Rendering follows file order, so `parentId` is not consulted:
// omp's file is really a tree and its own TUI renders pathTo(leaf), so a session
// rewound onto a new branch shows the abandoned turns here too. That matches the
// Claude decoder, which ignores `parentUuid` the same way; unwinding the branch
// needs a stateful decoder contract shared by every agent, not an omp-only fix.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

/**
 * omp session rows: `type: 'message'` turns carrying user/assistant/toolResult/
 * developer records with text, thinking, toolCall and image content blocks, the
 * content-less bash/python execution cells, plus the `type: 'custom_message'`
 * rows extensions inject into the conversation.
 * Session bookkeeping rows (session_init, mode_change, compaction, custom) are
 * skipped, as are records of an unrecognized type.
 */
export function decodeOmpTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record || (record.type !== 'message' && record.type !== 'custom_message')) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = parseTimestamp(record.timestamp)

  if (record.type === 'custom_message') {
    // Why: these extension-authored turns reach the model, and omp's own
    // transcript renders them — but only when `display` is set; the rest are
    // extension state it never shows (CustomMessageEntry, session-entries.d.ts).
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
    // Why: omp persists a TUI `!command` / python run as a content-less message
    // ({role, command|code, output, exitCode}) and renders it as a command cell.
    // Surface it as a tool turn so the output keeps its collapsible affordance.
    return {
      id,
      role: 'tool',
      blocks: ompExecutionBlocks(role, message),
      timestamp,
      source: 'transcript'
    }
  }

  if (role === 'fileMention') {
    // Why: an `@path` attachment is another content-less record omp's transcript
    // renders. List the paths only — `files[].content` is an auto-read dump that
    // would bury the conversation.
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

  // Why: sessions written before version 3 stored extension turns as
  // `type: 'message'` with role custom/hookMessage and a message-level
  // `display` flag (the v3 migration rewrites hookMessage -> custom). Honor the
  // same gate the `custom_message` branch does, or a resumed legacy session
  // renders state omp itself hides.
  if ((role === 'custom' || role === 'hookMessage') && message.display !== true) {
    return null
  }
  const blocks = ompContentBlocks(message.content)
  if (blocks.length === 0) {
    // Why: omp stamps an aborted turn onto the assistant message itself
    // (`stopReason: 'aborted'`), and when nothing streamed before the abort the
    // content is empty — so the turn would silently vanish. Surface it as the
    // same interrupted row Claude and Codex emit for their own aborts.
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
  const messageRole = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system'
  return { id, role: messageRole, blocks, timestamp, source: 'transcript' }
}

/** A bash/python execution cell: the invocation, then its captured output. */
function ompExecutionBlocks(
  role: 'bashExecution' | 'pythonExecution',
  message: Record<string, unknown>
): NativeChatBlock[] {
  const isBash = role === 'bashExecution'
  // Why: read these raw rather than via `extractString` — it trims, and leading
  // or trailing whitespace is meaningful in captured command output.
  const source = isBash ? message.command : message.code
  const output = message.output
  // Why: every cancel/timeout path returns `{exitCode: undefined, cancelled: true}`,
  // and JSON.stringify drops the undefined key, so a cancelled run carries NO
  // exitCode on disk. Without the `cancelled` arm it would render as a clean
  // success next to partial output; omp's own cell shows a cancelled marker.
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

/** The `path` of every entry in a fileMention's `files` array. */
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

/** Build the blocks for one omp content array. */
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

/** Map one omp content entry; unknown block types yield null and are dropped. */
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
    case 'image':
      // Why: omp stores images as content-addressed blob handles
      // (`blob:sha256:…`) rather than a path or URL, so there is nothing the
      // renderer can load. Dropping the block matches how the Claude mapper
      // treats an image record with neither source.
      return null
    default:
      return null
  }
}

/** `timestampMs` yields NaN for an unparsable value; the chat model wants null. */
function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
