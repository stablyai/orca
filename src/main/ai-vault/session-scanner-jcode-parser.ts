import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
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
  messages?: TranscriptMessageSink
}

const PREVIEW_ROLE_BY_MESSAGE_ROLE: Record<string, 'user' | 'assistant' | 'tool' | 'unknown'> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool'
}

/** Internal display roles and scheduled runs must not seed conversation counts, titles or previews. */
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
  // Seed explicit titles before messages so the first prompt cannot replace them.
  accumulator.title =
    normalizeTitleText(extractString(record.custom_title) ?? '') ||
    normalizeTitleText(extractString(record.title) ?? '') ||
    null
  accumulator.cwd = extractString(record.working_dir) ?? extractString(record.working_directory)
  updateTimeline(accumulator, record.created_at)
  updateTimeline(accumulator, record.updated_at)

  // Ignore the live journal: its appends do not change the document signature used by the parse cache.
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
  addSessionContent(accumulator, role, content, messageRecord.timestamp)
}
