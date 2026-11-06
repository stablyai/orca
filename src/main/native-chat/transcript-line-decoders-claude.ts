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
import { claudeContentBlocksWork } from './transcript-record-blocks'
import { finishTranscriptWork, type TranscriptWork } from './transcript-work-scheduler'
import { unwrapClaudePastedContentBlock } from '../../shared/claude-pasted-content'
import { unwrapClaudeBashInputBlock } from '../../shared/claude-bash-input'
import { claudeInterruptedMessageId } from './transcript-turn-markers'
import { claudeStopHookFeedbackRow } from '../claude/claude-stop-hook-feedback'
import { structuredAgentSessionStatusBlock } from '../../shared/agent-session/view/structured-agent-session-status-block'

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

function* withEditPatch(
  blocks: NativeChatBlock[],
  patch: NativeChatEditPatch
): TranscriptWork<NativeChatBlock[]> {
  let attached = false
  const patched: NativeChatBlock[] = []
  for (const block of blocks) {
    yield 1
    if (attached || block.type !== 'tool-result') {
      patched.push(block)
      continue
    }
    attached = true
    patched.push({ ...block, editPatch: patch })
  }
  return patched
}

export function decodeClaudeTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  return decodeClaudeTranscriptRecord(parseJsonObject(line), fallbackId)
}

export function decodeClaudeTranscriptRecord(
  parsed: Record<string, unknown> | null,
  fallbackId: string
): NativeChatMessage | null {
  return finishTranscriptWork(decodeClaudeTranscriptRecordWork(parsed, fallbackId))
}

export function* decodeClaudeTranscriptRecordWork(
  parsed: Record<string, unknown> | null,
  fallbackId: string
): TranscriptWork<NativeChatMessage | null> {
  if (!parsed) {
    return null
  }
  const record = claudeQueuedPromptAsUserRecord(parsed) ?? parsed
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
  const contentBlocks = yield* claudeContentBlocksWork(message?.content)
  const decodedBlocks = editPatch ? yield* withEditPatch(contentBlocks, editPatch) : contentBlocks
  if (decodedBlocks.length === 0) {
    return null
  }
  // Meta user turns may still contain genuine tool output.
  const isInjectedUserTurn =
    role === 'user' &&
    (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true)
  const stopHookFeedback = isInjectedUserTurn ? claudeStopHookFeedbackMessage(decodedBlocks) : null
  if (stopHookFeedback) {
    return { id: recordMessageId, timestamp, source: 'transcript', ...stopHookFeedback, ...parent }
  }
  // Keep image-source companions despite isMeta: prompt base64 has no path and cannot render attachments.
  let blocks = decodedBlocks
  if (isInjectedUserTurn && !(yield* isImageSourceRecord(decodedBlocks))) {
    blocks = []
    for (const block of decodedBlocks) {
      yield 1
      if (block.type === 'tool-result') {
        blocks.push(block)
      }
    }
  }
  if (blocks.length === 0) {
    return null
  }
  const messageId = extractString(record.uuid) ?? extractString(message?.id)
  const messageRole = yield* claudeMessageRole(role, blocks, message?.content)
  let unwrapped = blocks
  if (role === 'user') {
    unwrapped = []
    for (const block of blocks) {
      yield 1
      unwrapped.push(unwrapClaudeBashInputBlock(unwrapClaudePastedContentBlock(block)))
    }
  }
  return {
    id: messageId ?? fallbackId,
    role: messageRole,
    // Decode ! command echoes so harness filtering cannot hide them and strand the local echo.
    blocks: unwrapped,
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
  return { ...record, type: 'user', message: { role: 'user', content: prompt } }
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
function* isImageSourceRecord(blocks: NativeChatBlock[]): TranscriptWork<boolean> {
  if (blocks.length === 0) {
    return false
  }
  for (const block of blocks) {
    yield 1
    if (block.type !== 'text' || imageSourcePathFromText(block.text) === null) {
      return false
    }
  }
  return true
}

function* claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[],
  content: unknown
): TranscriptWork<NativeChatMessage['role']> {
  if (role === 'user') {
    for (const block of blocks) {
      yield 1
      if (block.type !== 'tool-result') {
        return 'user'
      }
    }
    return blocks.length > 0 ? 'tool' : 'user'
  }
  return (yield* isThinkingOnlyContent(content)) ? 'reasoning' : role
}

// Decoded thinking becomes a text block, so classify from the raw content parts.
function* isThinkingOnlyContent(content: unknown): TranscriptWork<boolean> {
  if (!Array.isArray(content) || content.length === 0) {
    return false
  }
  for (const part of content) {
    yield 1
    const type = asRecord(part)?.type
    if (type !== 'thinking' && type !== 'redacted_thinking') {
      return false
    }
  }
  return true
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
