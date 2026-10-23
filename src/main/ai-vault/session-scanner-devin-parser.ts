import { readStreamedSessionDocument } from './session-document-stream'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addDecodedSessionMessage } from './session-scanner-messages'
import { decodeSessionMessage, type DecodedSessionMessage } from './session-decoded-message'
import {
  arrayValue,
  asRecord,
  extractContentText,
  extractString,
  numberValue
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseDevinSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseDevinSessionDocument(
    file,
    openTranscriptReadStream(file.path, {}, 'scan'),
    platform,
    {},
    signal,
    messages
  )
}

/** Remote transcript content, streamed from a host that has no reader attached. */
export function parseDevinSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  return parseDevinSessionRecord(file, content, platform, options)
}

function parseDevinSessionRecord(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: ParserSessionOptions,
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return null
  }
  const sessionId =
    extractString(record.session_id) ??
    extractString(record.sessionId) ??
    sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'devin', file, sessionId, messages })
  const agentRecord = asRecord(record.agent)
  accumulator.model =
    extractString(agentRecord?.model_name) ??
    extractString(agentRecord?.model) ??
    extractString(record.generation_model)
  accumulator.cwd = extractString(record.working_directory)
  for (const step of arrayValue(record.steps)) {
    consumeDevinSessionStep(accumulator, step)
  }
  return finalizeSession(accumulator, platform, options)
}

function decodeDevinStepMessage(
  step: Record<string, unknown>,
  role: 'user' | 'assistant',
  includeTools: boolean
): DecodedSessionMessage | null {
  const wrapped = asRecord(step.message)
  for (const content of [wrapped ? wrapped.content : step.message, step.text, step.content]) {
    const message = decodeSessionMessage(role, content, null, { includeTools })
    if (message.blocks.some((block) => ('text' in block ? block.text.trim().length > 0 : true))) {
      return message
    }
  }
  return null
}

// Each bucket resolves from the first source that reports it. ATIF
// `prompt_tokens` already includes `cached_tokens`, so only the Claude-style
// cache keys (which sit outside input_tokens) are summed.
function devinStepTokenTotal(
  metadata: Record<string, unknown> | null,
  metrics: Record<string, unknown> | null,
  stepMetrics: Record<string, unknown> | null
): number {
  const sources = [metadata, metrics, stepMetrics]
  return (
    firstDevinMetricValue(sources, ['total_input_tokens', 'input_tokens', 'prompt_tokens']) +
    firstDevinMetricValue(sources, ['output_tokens', 'completion_tokens']) +
    firstDevinMetricValue(sources, ['cache_read_tokens', 'cache_read_input_tokens']) +
    firstDevinMetricValue(sources, ['cache_creation_tokens', 'cache_creation_input_tokens'])
  )
}

function firstDevinMetricValue(
  sources: readonly (Record<string, unknown> | null)[],
  keys: readonly string[]
): number {
  for (const source of sources) {
    if (!source) {
      continue
    }
    for (const key of keys) {
      const rawValue = source[key]
      const value = numberValue(rawValue)
      if (value > 0 || (value === 0 && typeof rawValue === 'number' && Number.isFinite(rawValue))) {
        return value
      }
    }
  }
  return 0
}

export function consumeDevinSessionStep(accumulator: SessionAccumulator, step: unknown): void {
  const stepRecord = asRecord(step)
  if (!stepRecord) {
    return
  }
  const metadata = asRecord(stepRecord.metadata)
  updateTimeline(
    accumulator,
    extractString(stepRecord.timestamp) ?? extractString(metadata?.created_at)
  )
  const metrics = asRecord(metadata?.metrics)
  const extra = asRecord(stepRecord.extra)
  accumulator.model ??=
    extractString(stepRecord.model_name) ??
    extractString(extra?.generation_model) ??
    extractString(metadata?.generation_model) ??
    extractString(metrics?.generation_model)
  accumulator.totalTokens += devinStepTokenTotal(metadata, metrics, asRecord(stepRecord.metrics))
  // ATIF `source` is 'user' | 'agent' | 'system'; system steps are setup noise
  // that must not count as messages or feed title/preview.
  const source = extractString(stepRecord.source)
  const isSystem = source === 'system'
  const isUser = !isSystem && (source === 'user' || metadata?.is_user_input === true)
  if (
    isSystem ||
    (!isUser &&
      source !== 'agent' &&
      extractString(stepRecord.role) !== 'assistant' &&
      !stepRecord.tool_calls)
  ) {
    return
  }
  accumulator.messageCount++
  const message = decodeDevinStepMessage(
    stepRecord,
    isUser ? 'user' : 'assistant',
    accumulator.messages.active
  )
  if (!message) {
    return
  }
  if (isUser) {
    accumulator.title ??= extractContentText(
      message.blocks.flatMap((block) => ('text' in block ? [block.text] : []))
    )
  }
  addDecodedSessionMessage(accumulator, message)
}

export async function parseDevinSessionDocument(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer>,
  platform: NodeJS.Platform,
  options: ParserSessionOptions,
  signal?: AbortSignal,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const parsed = await readStreamedSessionDocument({
    bytes,
    arrayKey: 'steps',
    fields: ['session_id', 'sessionId', 'generation_model', 'working_directory'],
    objectFields: { agent: ['model_name', 'model'] },
    create: () => {
      messages?.reset?.()
      return createAccumulator({
        agent: 'devin',
        file,
        sessionId: sessionIdFromFileName(file.path),
        messages
      })
    },
    consume: consumeDevinSessionStep,
    signal
  })
  if (!parsed) {
    return null
  }
  const { record, state: accumulator } = parsed
  accumulator.sessionId =
    extractString(record.session_id) ??
    extractString(record.sessionId) ??
    sessionIdFromFileName(file.path)
  const agentRecord = asRecord(record.agent)
  accumulator.model =
    extractString(agentRecord?.model_name) ??
    extractString(agentRecord?.model) ??
    extractString(record.generation_model) ??
    accumulator.model
  accumulator.cwd = extractString(record.working_directory)
  return finalizeSession(accumulator, platform, options)
}
