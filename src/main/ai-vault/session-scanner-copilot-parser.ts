import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorFoldResumeState,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionText } from './session-scanner-messages'
import {
  asRecord,
  copilotModelMetricsTotal,
  extractString,
  extractTrustedFolder,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseCopilotSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseCopilotSessionLines({ file, lines, platform, messages })
}

function consumeCopilotRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const data = asRecord(record.data)
  if (record.type === 'session.start' && data) {
    const sessionId = extractString(data.sessionId)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    updateTimeline(accumulator, extractString(data.startTime))
    // Folder-trust notices are optional; session.start records the launch directory.
    const context = asRecord(data.context)
    if (context) {
      accumulator.cwd ??= extractString(context.cwd) ?? extractString(context.gitRoot)
      accumulator.branch ??= extractString(context.branch)
    }
    return
  }
  if (record.type === 'session.model_change' && data) {
    accumulator.model = extractString(data.newModel) ?? accumulator.model
    return
  }
  if (record.type === 'session.info' && data) {
    accumulator.cwd ??= extractTrustedFolder(data.message)
    return
  }
  if (record.type === 'user.message' && data) {
    accumulator.messageCount++
    // Why: transformedContent is the prompt plus context Copilot injects (`<current_datetime>`).
    const text = extractString(data.content) ?? extractString(data.transformedContent)
    accumulator.title ??= normalizeTitleText(text ?? '')
    addSessionText(accumulator, { role: 'user', text, timestamp: record.timestamp })
    return
  }
  if (record.type === 'assistant.message' && data) {
    accumulator.messageCount++
    addSessionText(accumulator, {
      role: 'assistant',
      text: extractString(data.content),
      timestamp: record.timestamp
    })
    return
  }
  if (record.type === 'session.shutdown' && data) {
    accumulator.model = extractString(data.currentModel) ?? accumulator.model
    accumulator.totalTokens += numberValue(data.currentTokens)
    accumulator.totalTokens += copilotModelMetricsTotal(data.modelMetrics)
  }
}

export function createCopilotSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({
      agent: 'copilot',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    consumeCopilotRecordLine
  )
}

async function parseCopilotSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createCopilotSessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
