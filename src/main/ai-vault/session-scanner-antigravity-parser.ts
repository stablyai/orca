import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  timestampIso,
  updateTimeline
} from './session-scanner-accumulator'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'
import { antigravityHistoryPromptHash } from './antigravity-history-prompt'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseAntigravitySessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const state = createAntigravitySessionResumeState(file, messages)
  const read = await consumeCompleteJsonlLines({
    path: file.path,
    start: 0,
    onLine: (line) => state.consumeLine(line)
  })
  if (read.trailingPartialLine) {
    state.consumeLine(read.trailingPartialLine)
  }
  return state.finalize(platform)
}

export async function parseAntigravitySessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseAntigravitySessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
}

export function createAntigravitySessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  const sessionId = antigravityConversationIdFromTranscriptPath(file.path) ?? ''
  // Why: the transcript has no cwd/model fields. Workspace enrichment is a
  // separate, conservative history join; protobuf/SQLite blobs are unstable.
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'antigravity', file, sessionId, messages }),
    consumeAntigravityRecordLine
  )
}

async function parseAntigravitySessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createAntigravitySessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

function consumeAntigravityRecordLine(accumulator: SessionAccumulator, line: string): void {
  if (Buffer.byteLength(line) > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
    return
  }
  const record = parseJsonObject(line)
  if (!record) {
    return
  }

  updateTimeline(accumulator, record.created_at)
  const source = extractString(record.source)
  const type = extractString(record.type)
  const content = extractString(record.content)

  if (
    (source === 'USER_EXPLICIT' || source === 'USER') &&
    (type === 'USER_INPUT' || type === 'REQUEST')
  ) {
    const request = extractAntigravityUserRequest(content ?? '')
    if (!request) {
      return
    }
    accumulator.messageCount++
    if (accumulator.antigravityOpeningPrompt === undefined) {
      const hash = antigravityHistoryPromptHash(request)
      accumulator.antigravityOpeningPrompt = hash
        ? { hash, timestamp: timestampIso(record.created_at) }
        : null
    }
    accumulator.title ??= normalizeTitleText(request)
    addPreviewMessage(accumulator, { role: 'user', text: request, timestamp: record.created_at })
    return
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content) {
    accumulator.messageCount++
    addPreviewMessage(accumulator, {
      role: 'assistant',
      text: content,
      timestamp: record.created_at
    })
  }
}

function extractAntigravityUserRequest(content: string): string | null {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  if (startIndex === -1) {
    return extractString(content)
  }
  const bodyStart = startIndex + opener.length
  const endIndex = content.indexOf('</USER_REQUEST>', bodyStart)
  return extractString(
    endIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, endIndex)
  )
}
