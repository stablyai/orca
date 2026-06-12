import { readFile } from 'fs/promises'
import type { AiVaultSession } from '../../shared/ai-vault-types'
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
  normalizeTitleText,
  numberValue
} from './session-scanner-values'

export async function parseDevinSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const record = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
  if (!record) {
    return null
  }
  const sessionId =
    extractString(record.session_id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'devin', file, sessionId })
  const agentRecord = asRecord(record.agent)
  accumulator.model = extractString(agentRecord?.model_name)
  accumulator.cwd = extractString(record.working_directory)
  const steps = arrayValue(record.steps)
  for (const step of steps) {
    const stepRecord = asRecord(step)
    if (!stepRecord) {
      continue
    }
    const metadata = asRecord(stepRecord.metadata)
    updateTimeline(accumulator, extractString(metadata?.created_at))
    const metrics = asRecord(metadata?.metrics)
    const inputTokens = numberValue(metrics?.input_tokens)
    const outputTokens = numberValue(metrics?.output_tokens)
    accumulator.totalTokens += inputTokens + outputTokens
    const isUser = metadata?.is_user_input === true
    if (isUser) {
      accumulator.messageCount++
      const text =
        extractDevinStepText(stepRecord) ??
        extractContentText(stepRecord.content) ??
        extractString(stepRecord.text)
      const titleCandidate = normalizeTitleText(text ?? '')
      if (titleCandidate) {
        accumulator.title ??= titleCandidate
      }
      addPreviewContent(accumulator, 'user', text ?? stepRecord.content)
    } else if (extractString(stepRecord.role) === 'assistant' || stepRecord.tool_calls) {
      accumulator.messageCount++
      addPreviewContent(
        accumulator,
        'assistant',
        extractDevinStepText(stepRecord) ?? stepRecord.content
      )
    }
  }
  return finalizeSession(accumulator, platform)
}

function extractDevinStepText(step: Record<string, unknown>): string | null {
  const message = asRecord(step.message)
  if (message) {
    return extractContentText(message.content) ?? extractString(message.content)
  }
  return extractString(step.text)
}