// omp (pi-agent) JSONL line → NativeChatMessage decoder.
//
// Conversation turns are `type: 'message'`; every other record type is session
// bookkeeping. Rendering follows file order, so `parentId` is not consulted:
// omp's file is really a tree and its own TUI renders pathTo(leaf), so a session
// rewound onto a new branch shows the abandoned turns here too. That matches the
// Claude decoder, which ignores `parentUuid` the same way; unwinding the branch
// needs a stateful decoder contract shared by every agent, not an omp-only fix.

import {
  ompAdvisorNotesText,
  ompAdvisorTurnId,
  readOmpAdvisorNotes
} from '../../shared/omp-advisor-notes'
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
): NativeChatMessage | NativeChatMessage[] | null {
  const record = parseJsonObject(line)
  if (!record || (record.type !== 'message' && record.type !== 'custom_message')) {
    return null
  }
  const decoded = decodeOmpRecord(record, fallbackId)
  if (decoded === null) {
    return null
  }
  // The message's OWN clock, not the envelope's write time. An RPC history page
  // carries only the inner message (omp-rpc-history-decode.ts), so this is the
  // one reading both sources share — and the envelope is stamped at persist
  // time, seconds later. Cross-source record identity needs the shared one.
  const originTimestamp = parseTimestamp(asRecord(record.message)?.timestamp)
  if (originTimestamp === null) {
    return decoded
  }
  return Array.isArray(decoded)
    ? decoded.map((message) => ({ ...message, originTimestamp }))
    : { ...decoded, originTimestamp }
}

function decodeOmpRecord(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | NativeChatMessage[] | null {
  const id = extractString(record.id) ?? fallbackId
  const timestamp = parseTimestamp(record.timestamp)

  if (record.type === 'custom_message') {
    // Why: these extension-authored turns reach the model, and omp's own
    // transcript renders them — but only when `display` is set; the rest are
    // extension state it never shows (CustomMessageEntry, session-entries.d.ts).
    if (record.display !== true) {
      return null
    }
    const advisor = decodeOmpAdvisorCard(record, id, timestamp)
    if (advisor) {
      return advisor
    }
    const customBlocks = ompContentBlocks(record.content)
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
    const toolCallId = extractString(message.toolCallId)
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output: toolResultOutput(message.content),
          ...(message.isError === true ? { isError: true } : {}),
          ...(toolCallId ? { toolCallId } : {})
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
  // The hydrated `get_messages_page` path re-wraps a bare AgentMessage in this
  // envelope (omp-rpc-history-decode.ts), so an advisor card reaches the
  // decoder here as well as through `custom_message` — both must resolve to the
  // same turn identity or the two copies render twice.
  if (role === 'custom') {
    const advisor = decodeOmpAdvisorCard(message, id, timestamp)
    if (advisor) {
      return advisor
    }
  }
  // Bug 2a (wave 7): omp's `thinking` content blocks used to flatten into the
  // same message's `blocks` as ordinary text, rendering reasoning as plain
  // assistant prose — visually indistinguishable from the reply, and
  // inconsistent with the RPC overlay path, which already models reasoning as
  // its own `role: 'reasoning'` message (omp-rpc-turn-reducer.ts). Split the
  // content array into a reasoning bucket and everything else instead, so a
  // mixed thinking+reply turn becomes two messages (reasoning first) and a
  // thinking-only turn becomes a reasoning message rather than an assistant
  // one. The reasoning message keeps a suffixed, still-stable id so it never
  // collides with the primary message's own (unchanged) id.
  const { reasoningBlocks, blocks } = ompSplitReasoningContent(message.content)
  if (blocks.length === 0 && reasoningBlocks.length === 0) {
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
  const messages: NativeChatMessage[] = []
  if (reasoningBlocks.length > 0) {
    messages.push({
      id: `${id}:reasoning`,
      role: 'reasoning',
      blocks: reasoningBlocks,
      timestamp,
      source: 'transcript'
    })
  }
  if (blocks.length > 0) {
    messages.push({ id, role: messageRole, blocks, timestamp, source: 'transcript' })
  }
  return messages.length === 1 ? messages[0] : messages
}

/** An advisor note batch, rendered as its own attributed row rather than the
 *  agent-facing `<advisory>` XML the generic custom-message path would show
 *  verbatim. The `turnId` (content plus the card's own clock) is what collapses
 *  this copy against the live RPC frame's (omp-rpc-turn-overlay.ts) — no
 *  carrier supplies a shared id. Null when the record is not an advisor card. */
function decodeOmpAdvisorCard(
  record: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  const notes = readOmpAdvisorNotes(record)
  // A bare AgentMessage carries the card clock as epoch ms on the message
  // itself; a persisted entry has only the ISO envelope, which omp stamped
  // from that same value.
  const cardClock = typeof record.timestamp === 'number' ? record.timestamp : timestamp
  const turnId = ompAdvisorTurnId(notes, cardClock)
  if (!turnId) {
    return null
  }
  return {
    id,
    role: 'system',
    blocks: [{ type: 'text', text: ompAdvisorNotesText(notes) }],
    timestamp,
    source: 'transcript',
    turnId
  }
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

/** Splits one omp content array into its reasoning portion (`thinking`
 *  entries, each becoming a plain text block) and everything else, preserving
 *  each bucket's own relative order. Realistically only ever populated for an
 *  assistant turn, but content-shape driven (not role-gated) so a turn with no
 *  thinking entries costs nothing extra. */
function ompSplitReasoningContent(content: unknown): {
  reasoningBlocks: NativeChatBlock[]
  blocks: NativeChatBlock[]
} {
  if (!Array.isArray(content)) {
    return { reasoningBlocks: [], blocks: ompContentBlocks(content) }
  }
  const reasoningBlocks: NativeChatBlock[] = []
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (record?.type === 'thinking') {
      const text = extractString(record.thinking) ?? extractString(record.text)
      if (text) {
        reasoningBlocks.push({ type: 'text', text })
      }
      continue
    }
    const block = ompContentBlock(record)
    if (block) {
      blocks.push(block)
    }
  }
  return { reasoningBlocks, blocks }
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
      const toolCallId = extractString(record.id)
      return {
        type: 'tool-call',
        name,
        input: record.arguments,
        ...(toolCallId ? { toolCallId } : {})
      }
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
