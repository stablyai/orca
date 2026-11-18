import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { readHermesConversation } from '../../../ai-vault/scanners/hermes/hermes-state-db-conversations'
import { readHermesSchema } from '../../../ai-vault/scanners/hermes/hermes-state-db-schema'
import {
  decodedContent,
  displayedMessages,
  readMessageBodies,
  readMessageIdentities,
  type MessageRow
} from '../../../ai-vault/scanners/hermes/hermes-state-db-messages'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'
import { readOpenCodeDatabase } from '../../../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'
// Electron-free: runs in the SQLite reader worker.

// Import keeps a 16 KiB head of each block; reading more only crosses the worker boundary to be cut.
const BLOCK_TEXT_LIMIT = 64 * 1024
// Under the WSL guest's response frame; the import keeps its own newest 16 MiB of what this returns.
const TRANSCRIPT_BYTES = 24 * 1024 * 1024

const bounded = (text: string) => sliceAtCodeUnitLimit(text, BLOCK_TEXT_LIMIT)

function textBlocks(content: unknown): NativeChatBlock[] {
  const parts = Array.isArray(content) ? content : [content]
  return parts.flatMap((part): NativeChatBlock[] => {
    // Inline images are base64 a transcript can't carry; mark where they were.
    if (asRecord(part)?.type === 'image_url') {
      return [{ type: 'text', text: '[image]' }]
    }
    const text =
      typeof part === 'string'
        ? part
        : asRecord(part)?.type === 'text'
          ? asRecord(part)?.text
          : null
    return typeof text === 'string' && text.trim() ? [{ type: 'text', text: bounded(text) }] : []
  })
}

function toolCallBlocks(toolCalls: string | null): NativeChatBlock[] {
  let calls: unknown
  try {
    calls = toolCalls ? JSON.parse(toolCalls) : []
  } catch {
    return []
  }
  return (Array.isArray(calls) ? calls : []).flatMap((call): NativeChatBlock[] => {
    const record = asRecord(call)
    const fn = asRecord(record?.function)
    if (typeof fn?.name !== 'string') {
      return []
    }
    const input =
      typeof fn.arguments === 'string'
        ? (parseJsonObject(fn.arguments) ?? fn.arguments)
        : fn.arguments
    return [
      {
        type: 'tool-call',
        name: fn.name,
        input,
        ...(typeof record?.id === 'string' ? { callId: record.id } : {})
      }
    ]
  })
}

/** One Hermes display row as chat messages: its reasoning, then its text and tool calls or its tool result. */
function hermesChatMessages(row: MessageRow): NativeChatMessage[] {
  const base = { id: `${row.session_id}:${row.id}`, timestamp: row.timestamp * 1000 }
  const content = decodedContent(row)
  if (row.role === 'tool') {
    const output = bounded(typeof content === 'string' ? content : JSON.stringify(content ?? ''))
    return [
      {
        ...base,
        role: 'tool',
        blocks: [
          { type: 'tool-result', output, ...(row.tool_call_id ? { callId: row.tool_call_id } : {}) }
        ],
        source: 'transcript'
      }
    ]
  }
  if (row.role !== 'user' && row.role !== 'assistant') {
    return []
  }
  const messages: NativeChatMessage[] = []
  const text = textBlocks(content)
  const calls = row.role === 'assistant' ? toolCallBlocks(row.tool_calls) : []
  const parts = (row.reasoning?.trim() ? 1 : 0) + (text.length > 0 ? 1 : 0) + calls.length
  // Each part is its own item, as tool calls render as tool items only on their own.
  const id = (suffix: string) => (parts > 1 ? `${base.id}:${suffix}` : base.id)
  if (row.role === 'assistant' && row.reasoning?.trim()) {
    messages.push({
      ...base,
      id: id('reasoning'),
      role: 'reasoning',
      blocks: [{ type: 'text', text: bounded(row.reasoning) }],
      source: 'transcript'
    })
  }
  if (text.length > 0) {
    messages.push({ ...base, id: id('text'), role: row.role, blocks: text, source: 'transcript' })
  }
  calls.forEach((call, index) => {
    messages.push({
      ...base,
      id: id(`call:${index}`),
      role: 'assistant',
      blocks: [call],
      source: 'transcript'
    })
  })
  return messages
}

/** A Hermes conversation's newest history that fits the transcript budget, as Hermes displays it,
 *  oldest first; null when the store doesn't hold it. */
export function readHermesChatTranscript(args: {
  dbPath: string
  sessionId: string
}): NativeChatMessage[] | null {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => {
      const schema = readHermesSchema(db, args.dbPath)
      const conversation = schema && readHermesConversation(db, schema, args.sessionId)
      if (!schema || !conversation) {
        return null
      }
      const newestFirst = displayedMessages(
        readMessageIdentities(db, schema, conversation)
      ).toReversed()
      const rows: NativeChatMessage[][] = []
      let size = 0
      for (const row of readMessageBodies(db, schema, newestFirst, {
        full: true,
        tools: true,
        textChars: BLOCK_TEXT_LIMIT
      })) {
        const messages = hermesChatMessages(row)
        size += messages.reduce(
          (total, message) => total + Buffer.byteLength(JSON.stringify(message)),
          0
        )
        if (size > TRANSCRIPT_BYTES && rows.length > 0) {
          break
        }
        rows.push(messages)
      }
      return rows.toReversed().flat()
    }
  })
}

/** Whether the store holds this Hermes session, without reading its messages. */
export function hasHermesSession(args: { dbPath: string; sessionId: string }): boolean {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) =>
      !!readHermesSchema(db, args.dbPath) &&
      db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(args.sessionId) !== undefined
  })
}
