import { remoteSessionContentLines } from './remote-session-content-lines'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
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
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseCopilotSessionLines({ file, lines, platform })
}

export async function parseCopilotSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseCopilotSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
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
    return
  }
  if (record.type === 'session.model_change' && data) {
    accumulator.model = extractString(data.newModel) ?? accumulator.model
    return
  }
  if (record.type === 'session.info' && data) {
    accumulator.cwd = extractTrustedFolder(data.message) ?? accumulator.cwd
    return
  }
  if (record.type === 'user.message' && data) {
    accumulator.messageCount++
    accumulator.title ??= normalizeTitleText(
      extractString(data.transformedContent) ?? extractString(data.content) ?? ''
    )
    addPreviewMessage(accumulator, {
      role: 'user',
      text: extractString(data.transformedContent) ?? extractString(data.content),
      timestamp: record.timestamp
    })
    return
  }
  if (record.type === 'assistant.message' && data) {
    accumulator.messageCount++
    addPreviewMessage(accumulator, {
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

export function createCopilotSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'copilot', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeCopilotRecordLine
  )
}

async function parseCopilotSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createCopilotSessionResumeState(args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
