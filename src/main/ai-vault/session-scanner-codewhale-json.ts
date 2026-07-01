import { readFile } from 'node:fs/promises'
import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
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
  normalizeTitleText,
  numberValue
} from './session-scanner-values'

export type CodeWhaleJsonMessageRecord = {
  index: number
  role: AiVaultSessionPreviewMessage['role']
  content: unknown
}

export async function parseCodeWhaleSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codeWhaleHome: string | null = null
): Promise<AiVaultSession | null> {
  const text = await readFile(file.path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const metadata = asRecord(record.metadata)
  const sessionId = extractString(metadata?.id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'codewhale', file, sessionId })
  accumulator.title = normalizeTitleText(extractString(metadata?.title) ?? '')
  accumulator.cwd = extractString(metadata?.workspace)
  accumulator.model = extractString(metadata?.model)
  accumulator.totalTokens = numberValue(metadata?.total_tokens)
  updateTimeline(accumulator, metadata?.created_at)
  updateTimeline(accumulator, metadata?.updated_at)
  consumeCodeWhaleMessages(accumulator, codeWhaleJsonMessages(record))
  if (accumulator.messageCount === 0) {
    accumulator.messageCount = numberValue(metadata?.message_count)
  }
  return finalizeSession(accumulator, platform, { codeWhaleHome })
}

export function codeWhaleJsonMessages(
  record: Record<string, unknown>
): CodeWhaleJsonMessageRecord[] {
  const messages: CodeWhaleJsonMessageRecord[] = []
  arrayValue(record.messages).forEach((value, index) => {
    const message = asRecord(value)
    const role = codeWhaleJsonRole(message?.role)
    if (!message || !role) {
      return
    }
    messages.push({ index, role, content: message.content })
  })
  return messages
}

function consumeCodeWhaleMessages(
  accumulator: SessionAccumulator,
  messages: readonly CodeWhaleJsonMessageRecord[]
): void {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    accumulator.messageCount++
    if (message.role === 'user') {
      accumulator.title ??= extractContentText(message.content)
    }
    addPreviewContent(accumulator, message.role, message.content)
  }
}

function codeWhaleJsonRole(value: unknown): AiVaultSessionPreviewMessage['role'] | null {
  if (
    value === 'user' ||
    value === 'assistant' ||
    value === 'system' ||
    value === 'tool' ||
    value === 'unknown'
  ) {
    return value
  }
  return null
}
