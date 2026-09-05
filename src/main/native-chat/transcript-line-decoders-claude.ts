// Claude JSONL line → NativeChatMessage decoder.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatEditPatch,
  type NativeChatEditPatchHunk,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { imageSourcePathFromText } from '../../shared/native-chat-image-transcript-markers'
import { claudeContentBlocks } from './transcript-record-blocks'
import { claudeInterruptedMessageId } from './transcript-turn-markers'

const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400

/** Claude reports an edit as a snippet pair on the call, which cannot locate the
 *  change in the file. The result record carries the hunks it resolved against
 *  the real file, so keep them for the renderer's line-number gutter. */
function claudeEditPatch(record: Record<string, unknown>): NativeChatEditPatch | null {
  const result = asRecord(record.toolUseResult)
  const raw = result?.structuredPatch
  if (!Array.isArray(raw) || raw.length === 0) {
    return null
  }
  const hunks: NativeChatEditPatchHunk[] = []
  for (const entry of raw.slice(0, MAX_EDIT_PATCH_HUNKS)) {
    const hunk = asRecord(entry)
    const lines = hunk?.lines
    if (
      typeof hunk?.oldStart !== 'number' ||
      typeof hunk.newStart !== 'number' ||
      !Array.isArray(lines)
    ) {
      continue
    }
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : 0,
      newStart: hunk.newStart,
      newLines: typeof hunk.newLines === 'number' ? hunk.newLines : 0,
      lines: lines
        .slice(0, MAX_EDIT_PATCH_HUNK_LINES)
        .flatMap((line) => (typeof line === 'string' ? [line] : []))
    })
  }
  if (hunks.length === 0) {
    return null
  }
  const filePath = extractString(result?.filePath)
  return { ...(filePath ? { filePath } : {}), hunks }
}

/** Attaches the resolved hunks to the record's tool result, which is the only
 *  block in a Claude result turn. */
function withEditPatch(blocks: NativeChatBlock[], patch: NativeChatEditPatch): NativeChatBlock[] {
  let attached = false
  return blocks.map((block) => {
    if (attached || block.type !== 'tool-result') {
      return block
    }
    attached = true
    return { ...block, editPatch: patch }
  })
}

export function decodeClaudeTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const role = record.type
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordMessageId = extractString(record.uuid) ?? fallbackId
  if (claudeInterruptedMessageId(record)) {
    // Why: keep Claude's injected boilerplate out of the user-bubble path while
    // preserving the interruption as a quiet, replayable conversation status.
    return {
      id: recordMessageId,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  const message = asRecord(record.message)
  const editPatch = claudeEditPatch(record)
  const contentBlocks = claudeContentBlocks(message?.content)
  const decodedBlocks = editPatch ? withEditPatch(contentBlocks, editPatch) : contentBlocks
  if (decodedBlocks.length === 0) {
    return null
  }
  // Why: Claude structurally marks injected turns, but tool-result records are
  // genuine output and must remain visible even when the containing turn is meta.
  const isInjectedUserTurn =
    role === 'user' &&
    (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true)
  // Why image-source text survives the filter: Claude records a pasted image as a
  // companion turn marked `isMeta`, holding one `[Image: source: <path>]` block per
  // image. Dropping it left the prompt turn with no trace of its attachments — the
  // base64 blocks on the prompt itself carry no url/path and are dropped too — so a
  // turn with images rendered with no images at all.
  const blocks = isInjectedUserTurn
    ? isImageSourceRecord(decodedBlocks)
      ? decodedBlocks
      : decodedBlocks.filter((block) => block.type === 'tool-result')
    : decodedBlocks
  if (blocks.length === 0) {
    return null
  }
  const messageId = extractString(record.uuid) ?? extractString(message?.id)
  return {
    id: messageId ?? fallbackId,
    role: claudeMessageRole(role, blocks),
    blocks,
    timestamp,
    source: 'transcript'
  }
}

// Keep only genuine image companion records; a marker mixed with prose must
// remain an injected turn (or be dropped), never become an image-source turn.
function isImageSourceRecord(blocks: NativeChatBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text' && imageSourcePathFromText(block.text) !== null)
  )
}

// Claude marks reasoning via `thinking` content blocks; when a message is made
// up solely of reasoning, surface it as a reasoning-role message.
function claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[]
): NativeChatMessage['role'] {
  if (role === 'user') {
    const onlyToolResults = blocks.every((block) => block.type === 'tool-result')
    return onlyToolResults && blocks.length > 0 ? 'tool' : 'user'
  }
  return role
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
