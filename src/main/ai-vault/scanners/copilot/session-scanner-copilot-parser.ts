import { openTranscriptReadStream } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  accumulatorFoldResumeState,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionText } from '../../parsing/session-scanner-messages'
import { asRecord } from '../../parsing/session-record-fields'
import { copilotModelMetricsTotal, numberValue } from '../../parsing/session-scanner-token-values'
import { extractString } from '../../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../parsing/session-json-object'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'

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
    // currentTokens (context size) only stands in when modelMetrics is absent.
    const metrics = asRecord(data.modelMetrics)
    const tokens = metrics ? copilotModelMetricsTotal(metrics) : numberValue(data.currentTokens)
    // Why: CLIs that write accountingSnapshot restore it on resume, so their next shutdown repeats
    // this one's usage. Older CLIs restart metrics at zero each run, so their shutdowns add up.
    const cumulative = asRecord(data.accountingSnapshot) !== null
    if (cumulative && accumulator.copilotCumulativeShutdownTokens !== undefined) {
      accumulator.totalTokens -= accumulator.copilotCumulativeShutdownTokens
    }
    accumulator.totalTokens += tokens
    if (cumulative) {
      accumulator.copilotCumulativeShutdownTokens = tokens
    } else if (tokens > 0) {
      // A zero-usage older-CLI run leaves the restored snapshot, and so the baseline, unchanged.
      accumulator.copilotCumulativeShutdownTokens = undefined
    }
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

function extractTrustedFolder(value: unknown): string | null {
  const message = extractString(value)
  if (!message) {
    return null
  }
  return message.match(/^Folder (.+) has been added to trusted folders\.$/)?.[1] ?? null
}
