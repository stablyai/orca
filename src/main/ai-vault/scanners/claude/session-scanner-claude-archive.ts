import { basename, dirname, extname, join } from 'node:path'
import {
  readTranscriptSlice,
  wslGatedLstat
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { parseJsonObject } from '../../parsing/session-json-object'
import { asRecord } from '../../parsing/session-record-fields'
import type { FileWithMtime } from '../../session-scanner-types'

const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const ARCHIVE_MARKER_BYTES = 4096
const PROMPT_WINDOW_BYTES = 64 * 1024
const LEGACY_NON_PROMPT = /^(?:<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export async function isClaudeSessionArchived(
  file: Pick<FileWithMtime, 'path' | 'sizeBytes'>,
  signal?: AbortSignal
): Promise<boolean> {
  const id = basename(file.path, extname(file.path))
  if (!CLAUDE_SESSION_UUID.test(id)) {
    return false
  }
  // Claude writes this beside the JSONL, so check anew even when the transcript stat was cached.
  const marker = join(dirname(file.path), id, 'archived.json')
  try {
    const stats = await wslGatedLstat(marker, 'scan', signal)
    if (!stats.isFile() || stats.size > ARCHIVE_MARKER_BYTES) {
      return false
    }
    const bytes = await readTranscriptSlice(marker, 0, ARCHIVE_MARKER_BYTES + 1, 'scan', signal)
    const archive = bytes.length <= ARCHIVE_MARKER_BYTES ? parseJsonObject(bytes.toString()) : null
    if (archive?.archived !== true || typeof archive.at !== 'string') {
      return false
    }
    const archivedAt = Date.parse(archive.at)
    return Number.isFinite(archivedAt) && !(await hasLaterClaudePrompt(file, archivedAt, signal))
  } catch {
    // Discovery handles cancellation when it consumes the file or batch.
    return false
  }
}

async function hasLaterClaudePrompt(
  file: Pick<FileWithMtime, 'path' | 'sizeBytes'>,
  archivedAt: number,
  signal?: AbortSignal
): Promise<boolean> {
  // Like Claude's session reader, inspect bounded transcript ends only for marked sessions.
  const head = await readTranscriptSlice(file.path, 0, PROMPT_WINDOW_BYTES, 'scan', signal)
  if (containsLaterPrompt(head, archivedAt)) {
    return true
  }
  const tailOffset = (file.sizeBytes ?? 0) - PROMPT_WINDOW_BYTES
  if (tailOffset <= 0) {
    return false
  }
  const tail = await readTranscriptSlice(file.path, tailOffset, PROMPT_WINDOW_BYTES, 'scan', signal)
  return containsLaterPrompt(tail, archivedAt)
}

function containsLaterPrompt(bytes: Buffer, archivedAt: number): boolean {
  return bytes
    .toString()
    .split('\n')
    .some((line) => {
      if (!line.includes('"user"') && !line.includes('"queued_command"')) {
        return false
      }
      const row = parseJsonObject(line)
      if (
        typeof row?.timestamp !== 'string' ||
        !(Date.parse(row.timestamp) > archivedAt) ||
        row.isSidechain === true
      ) {
        return false
      }
      if (row.type === 'attachment') {
        const attachment = asRecord(row.attachment)
        return (
          attachment?.type === 'queued_command' &&
          attachment.isMeta !== true &&
          isClaudePrompt(attachment.prompt, attachment.origin)
        )
      }
      return (
        row.type === 'user' &&
        row.isMeta !== true &&
        row.isCompactSummary !== true &&
        row.isVirtual !== true &&
        row.isVisibleInTranscriptOnly !== true &&
        row.textNotTyped !== true &&
        row.handedOff !== true &&
        row.toolUseResult === undefined &&
        row.wakeupSource === undefined &&
        row.scheduledTaskId === undefined &&
        (row.turnOrigin === undefined || row.turnOrigin === 'human') &&
        isClaudePrompt(asRecord(row.message)?.content, row.origin)
      )
    })
}

function isClaudePrompt(content: unknown, origin: unknown): boolean {
  if (origin !== undefined && asRecord(origin)?.kind !== 'human') {
    return false
  }
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content.map(asRecord)
        : []
  if (blocks.some((block) => block?.type === 'tool_result')) {
    return false
  }
  return blocks.some((block) => {
    if (block?.type === 'image' || block?.type === 'document') {
      return true
    }
    const text = block?.type === 'text' && typeof block.text === 'string' ? block.text.trim() : ''
    return (
      text !== '' &&
      (origin !== undefined
        ? !text.startsWith('<command-name>')
        : text.startsWith('<command-message>') ||
          text.startsWith('<bash-input>') ||
          !LEGACY_NON_PROMPT.test(text))
    )
  })
}
