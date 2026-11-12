import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatEditPatch,
  type NativeChatEditPatchHunk,
  type NativeChatMessage
} from '../../shared/native-chat/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { imageSourcePathFromText } from '../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import { claudeContentBlocks } from './transcript-record-blocks'
import { isKnownRasterImageMimeType } from '../../shared/file-preview/raster-image-preview-limits'
import { unwrapClaudePastedContentBlock } from '../../shared/claude-pasted-content'
import { unwrapClaudeBashInputBlock } from '../../shared/claude-bash-input'
import { claudeInterruptedMessageId } from './transcript-turn-markers'
import { claudeStopHookFeedbackRow } from '../claude/structured/journal/claude-stop-hook-feedback'
import { structuredAgentSessionStatusBlock } from '../../shared/agent-session/view/structured-agent-session-status-block'
import {
  claudeMessageWithoutSyntheticText,
  isClaudeInjectedUserMessage
} from '../claude/structured/journal/claude-internal-message-content'

const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400

/** Render resolved result hunks; call-side snippet pairs cannot supply real file line numbers. */
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
  const parsed = parseJsonObject(line)
  if (!parsed) {
    return null
  }
  const record = claudeMessageWithoutSyntheticText(claudeQueuedPromptAsUserRecord(parsed) ?? parsed)
  if (!record) {
    return null
  }
  const role = record.type
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordMessageId = extractString(record.uuid) ?? fallbackId
  // parentUuid pairs local command output with its command row.
  const parentUuid = extractString(record.parentUuid)
  const parent = parentUuid ? { parentId: parentUuid } : {}
  if (claudeInterruptedMessageId(record)) {
    // Render injected interruption text as quiet status rather than a user bubble.
    return {
      id: recordMessageId,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript',
      ...parent
    }
  }
  const message = asRecord(record.message)
  const editPatch = claudeEditPatch(record)
  const contentBlocks = claudeContentBlocks(message?.content)
  const decodedBlocks = editPatch ? withEditPatch(contentBlocks, editPatch) : contentBlocks
  if (decodedBlocks.length === 0) {
    return null
  }
  // Meta user turns may still contain genuine tool output.
  const isInjectedUserTurn = isClaudeInjectedUserMessage(record)
  const stopHookFeedback = isInjectedUserTurn ? claudeStopHookFeedbackMessage(decodedBlocks) : null
  if (stopHookFeedback) {
    return { id: recordMessageId, timestamp, source: 'transcript', ...stopHookFeedback, ...parent }
  }
  // Keep image-source companions despite isMeta: prompt base64 has no path and cannot render attachments.
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
    role: claudeMessageRole(role, blocks, message?.content),
    // Decode ! command echoes so harness filtering cannot hide them and strand the local echo.
    blocks:
      role === 'user'
        ? blocks.map((block) => unwrapClaudeBashInputBlock(unwrapClaudePastedContentBlock(block)))
        : blocks,
    timestamp,
    source: 'transcript',
    ...parent
  }
}

/** Mid-turn human prompts exist only as queued_command attachments; decode them to reconcile local echoes. */
function claudeQueuedPromptAsUserRecord(
  record: Record<string, unknown>
): Record<string, unknown> | null {
  if (record.type !== 'attachment') {
    return null
  }
  const attachment = asRecord(record.attachment)
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') {
    return null
  }
  // Legacy prompt-mode queue entries omit origin and are human-authored.
  const originKind = asRecord(attachment.origin)?.kind
  if (originKind !== undefined && originKind !== 'human') {
    return null
  }
  const prompt = attachment.prompt
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) {
    return null
  }
  const content = Array.isArray(prompt) ? prompt.map(queuedPromptImageAsDataUrl) : prompt
  return { ...record, type: 'user', message: { role: 'user', content } }
}

// Queued prompts get no image-source companion row; their inline base64 is the only image record.
function queuedPromptImageAsDataUrl(item: unknown): unknown {
  const record = asRecord(item)
  const source = asRecord(record?.source)
  const mediaType = extractString(source?.media_type) ?? undefined
  const data = extractString(source?.data)
  if (
    record?.type !== 'image' ||
    source?.type !== 'base64' ||
    !data ||
    !isKnownRasterImageMimeType(mediaType)
  ) {
    return item
  }
  return { ...record, source: { url: `data:${mediaType};base64,${data}` } }
}

function claudeStopHookFeedbackMessage(
  blocks: NativeChatBlock[]
): Pick<NativeChatMessage, 'role' | 'blocks'> | null {
  const [block] = blocks
  const row =
    blocks.length === 1 && block?.type === 'text' ? claudeStopHookFeedbackRow(block.text) : null
  return row ? { role: 'system', blocks: [structuredAgentSessionStatusBlock(row)] } : null
}

// Mixed prose/markers are injected turns, never image-source companions.
function isImageSourceRecord(blocks: NativeChatBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text' && imageSourcePathFromText(block.text) !== null)
  )
}

function claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[],
  content: unknown
): NativeChatMessage['role'] {
  if (role === 'user') {
    const onlyToolResults = blocks.every((block) => block.type === 'tool-result')
    return onlyToolResults && blocks.length > 0 ? 'tool' : 'user'
  }
  return isThinkingOnlyContent(content) ? 'reasoning' : role
}

// Decoded thinking becomes a text block, so classify from the raw content parts.
function isThinkingOnlyContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => {
      const type = asRecord(part)?.type
      return type === 'thinking' || type === 'redacted_thinking'
    })
  )
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Anything but a typed record with no message, or a user record Claude flags as meta, may be a
 *  turn: what a transcript nothing was sent in lacks. */
export function mayBeClaudeConversationRecord(line: string): boolean {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return true
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return true
  }
  // A local command's caveat or output; the decoder still keeps any meta record it can show.
  if ('isMeta' in record && record.isMeta === true && 'type' in record && record.type === 'user') {
    return false
  }
  if ('message' in record) {
    return true
  }
  const type = 'type' in record ? record.type : undefined
  return typeof type !== 'string' || !type.trim() || type === 'user' || type === 'assistant'
}
