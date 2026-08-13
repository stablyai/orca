// Droid (Factory CLI) JSONL line → NativeChatMessage decoder.
//
// Droid writes Claude's content-block vocabulary (text / thinking / tool_use /
// tool_result) but wraps every turn as `{type: 'message', message: {...}}` and
// declares who each row was written for via `message.visibility`, so the shared
// `claudeContentBlocks` mapper is reused and only the envelope differs.

import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import {
  isTextBlock,
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
import { claudeContentBlocks } from './transcript-record-blocks'

/** Rows the conversation never shows:
 *  - `llm_only`: context Droid injects for the model only (external file-change
 *    notices); Droid's own transcript hides these too.
 *  - hook rows: `user_only` bookkeeping for a fired hook whose text is the event
 *    name ("Hook execution: PreToolUse"), usually with no content at all. */
function isDroidHiddenRow(message: Record<string, unknown>): boolean {
  return message.visibility === 'llm_only' || message.hookEventName !== undefined
}

/** Droid records an aborted turn as a `both`-visibility row carrying only its
 *  abort notice — the same conversation status Claude and Codex surface as an
 *  interrupted marker rather than as a prompt. */
const DROID_ABORT_NOTICES = new Set(['error: request was aborted.', 'request cancelled by user'])

function isDroidAbortNotice(message: Record<string, unknown>): boolean {
  if (message.visibility !== 'both' || !Array.isArray(message.content)) {
    return false
  }
  return (
    message.content.length > 0 &&
    message.content.every((item) => {
      const block = asRecord(item)
      const text = block?.type === 'text' ? extractString(block.text) : null
      return text !== null && DROID_ABORT_NOTICES.has(text.trim().toLowerCase())
    })
  )
}

/**
 * Decode one Droid session row. Conversation turns are `type: 'message'` with a
 * user or assistant role; session bookkeeping (`session_start`, `session_end`,
 * `todo_state`, `compaction_state`, `agent_turn_outcome`) and unknown record
 * types are skipped so one novel line can never fail a read.
 */
export function decodeDroidTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record || record.type !== 'message') {
    return null
  }
  const message = asRecord(record.message)
  if (!message) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = lineTimestamp(record.timestamp)
  if (isDroidAbortNotice(message)) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  if (isDroidHiddenRow(message)) {
    return null
  }
  const role = extractString(message.role)
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const blocks = droidBlocks(message, role)
  if (blocks.length === 0) {
    return null
  }
  return { id, role: droidRole(role, blocks), blocks, timestamp, source: 'transcript' }
}

function droidBlocks(
  message: Record<string, unknown>,
  role: 'user' | 'assistant'
): NativeChatBlock[] {
  const blocks = claudeContentBlocks(message.content)
  if (role === 'assistant') {
    return blocks
  }
  // Why: a `user_only` row that is not hook bookkeeping is Droid narrating to
  // the user — a cancelled tool call's synthetic result. Its tool output is real
  // conversation, but the prose beside it is chrome that must not be attributed
  // to the user as a prompt.
  if (message.visibility === 'user_only') {
    return blocks.filter((block) => block.type === 'tool-result')
  }
  // Why: unlike Claude, Droid appends injected context (system-reminders, tagged
  // file contents) as extra text blocks *inside* the user's own turn, so the
  // downstream whole-message noise filter cannot reach it. Drop per block.
  return blocks.filter(
    (block) => !isTextBlock(block) || !isKnownHarnessInjectedUserTurnText(block.text)
  )
}

/** Droid returns every tool's output as a user turn of `tool_result` blocks, so
 *  a row made up solely of them is the tool speaking, not the user. */
function droidRole(
  role: 'user' | 'assistant',
  blocks: readonly NativeChatBlock[]
): NativeChatMessage['role'] {
  if (role === 'assistant') {
    return 'assistant'
  }
  return blocks.every((block) => block.type === 'tool-result') ? 'tool' : 'user'
}

/** `timestampMs` yields NaN for an unparsable value; the chat model wants null. */
function lineTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
