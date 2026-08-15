import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime } from './session-scanner-types'
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

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

const PREVIEW_ROLE_BY_MESSAGE_ROLE: Record<string, 'user' | 'assistant' | 'tool' | 'unknown'> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool'
}

/** jcode marks injected session-context envelopes with role user + display_role system. */
function isInjectedContextMessage(message: Record<string, unknown>): boolean {
  return message.display_role === 'system' || message.role === 'system'
}

export async function parseJcodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  return parseJcodeSessionContent(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan'),
    platform
  )
}

export function parseJcodeSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return null
  }
  const sessionId =
    extractString(record.id) ?? extractString(record.session_id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'jcode', file, sessionId })
  accumulator.model = extractString(record.model)
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
  addPreviewContent(accumulator, role, content, messageRecord.timestamp)
}
