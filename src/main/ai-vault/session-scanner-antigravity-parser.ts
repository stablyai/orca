import type { AiVaultSession } from '../../shared/ai-vault-types'
import { iterateAiVaultJsonlLines } from './session-jsonl-line-reader'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  updateTimeline
} from './session-scanner-accumulator'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseAntigravitySessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = iterateAiVaultJsonlLines(file.path)
  return parseAntigravitySessionLines({ file, lines, platform })
}

export async function parseAntigravitySessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseAntigravitySessionLines({
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

export function createAntigravitySessionResumeState(
  file: FileWithMtime
): ResumableSessionParseState {
  const sessionId = antigravityConversationIdFromTranscriptPath(file.path) ?? ''
  // Why: the transcript has no cwd/model fields. Workspace enrichment is a
  // separate, conservative history join; protobuf/SQLite blobs are unstable.
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'antigravity', file, sessionId }),
    consumeAntigravityRecordLine
  )
}

async function parseAntigravitySessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createAntigravitySessionResumeState(args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

function consumeAntigravityRecordLine(accumulator: SessionAccumulator, line: string): void {
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
