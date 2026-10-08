import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  arrayValue,
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText
} from './session-scanner-values'
import { numberValue } from './session-scanner-token-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  // Why: where decoded messages go when the caller is streaming a transcript reader.
  messages?: TranscriptMessageSink
}

const PREVIEW_ROLE_BY_MESSAGE_ROLE: Record<string, 'user' | 'assistant' | 'tool' | 'unknown'> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool'
}

/** Messages jcode itself renders as internal rather than conversation.
 *
 *  `display_role` is `System | BackgroundTask` (StoredDisplayRole in
 *  crates/jcode-session-types/src/lib.rs), and a scheduled run opens with a
 *  `[Scheduled task]` user turn. Counting either inflates the message count and can
 *  take over the title and preview. */
function isInjectedContextMessage(message: Record<string, unknown>): boolean {
  if (message.display_role === 'system' || message.display_role === 'background_task') {
    return true
  }
  if (message.role === 'system') {
    return true
  }
  const text = extractContentText(message.content) ?? ''
  return text.startsWith('[Scheduled task]') || text.startsWith('<system-reminder>')
}

/** Sum of a stored message's usage, matching the other parsers' input+output total. */
function jcodeMessageTokens(message: Record<string, unknown>): number {
  const usage = asRecord(message.token_usage)
  return usage ? numberValue(usage.input_tokens) + numberValue(usage.output_tokens) : 0
}

export async function parseJcodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  return parseJcodeSessionContent(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan'),
    platform,
    messages ? { messages } : undefined
  )
}

export function parseJcodeSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Why: a partially written session doc must not abort the scan; skip it.
    return null
  }
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const sessionId =
    extractString(record.id) ?? extractString(record.session_id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({
    agent: 'jcode',
    file,
    sessionId,
    messages: options.messages
  })
  accumulator.model = extractString(record.model)
  // Why before the message walk: a session the user named keeps that name, rather
  // than being retitled from whatever its first prompt happened to say.
  accumulator.title =
    normalizeTitleText(extractString(record.custom_title) ?? '') ||
    normalizeTitleText(extractString(record.title) ?? '') ||
    null
  accumulator.cwd = extractString(record.working_dir) ?? extractString(record.working_directory)
  updateTimeline(accumulator, record.created_at)
  updateTimeline(accumulator, record.updated_at)

  // Why: parse only the durable `messages` array. The live `.journal.jsonl`
  // sibling is intentionally ignored: its writes do not bump this file's mtime,
  // so a merged read would go stale against the parse cache until the session
  // doc is rewritten (checkpoint/close).
  for (const message of arrayValue(record.messages)) {
    consumeJcodeMessage(accumulator, message)
  }

  return finalizeSession(accumulator, platform, options)
}

function consumeJcodeMessage(
  accumulator: ReturnType<typeof createAccumulator>,
  message: unknown
): void {
  const messageRecord = asRecord(message)
  if (!messageRecord || isInjectedContextMessage(messageRecord)) {
    return
  }
  updateTimeline(accumulator, messageRecord.timestamp)
  const role = PREVIEW_ROLE_BY_MESSAGE_ROLE[extractString(messageRecord.role) ?? ''] ?? 'unknown'
  const content = messageRecord.content
  if (role === 'user') {
    const titleCandidate = normalizeTitleText(extractContentText(content) ?? '')
    if (titleCandidate) {
      accumulator.title ??= titleCandidate
    }
  }
  accumulator.messageCount++
  accumulator.totalTokens += jcodeMessageTokens(messageRecord)
  addPreviewContent(accumulator, role, content, messageRecord.timestamp)
}
