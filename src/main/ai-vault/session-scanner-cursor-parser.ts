import { remoteSessionContentLines } from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
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
  addPreviewContent,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractContentText,
  extractMessageText,
  extractString,
  parseJsonObject
} from './session-scanner-values'
import { readCursorChatMeta } from './session-scanner-cursor-chat-meta'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseCursorSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseCursorSessionLines({ file, lines, platform })
}

export async function parseCursorSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseCursorSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options,
    enrichFromChatMeta: false
  })
}

function consumeCursorRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const role = extractString(record.role)
  if (role === 'user' || role === 'assistant') {
    accumulator.messageCount++
    if (role === 'user') {
      accumulator.title ??= extractMessageText(record.message) ?? extractContentText(record.content)
    }
    addPreviewContent(
      accumulator,
      role,
      asRecord(record.message)?.content ?? record.content,
      record.timestamp
    )
  }
}

export function createCursorSessionResumeState(
  file: FileWithMtime,
  // Remote hosts stream transcript content only, with no sibling meta.json to read.
  enrichFromChatMeta = true
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'cursor', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeCursorRecordLine,
    enrichFromChatMeta ? (accumulator) => applyCursorChatMeta(accumulator, file.path) : undefined
  )
}

/** Fills only what the transcript never recorded; its own records always win. */
async function applyCursorChatMeta(
  accumulator: SessionAccumulator,
  transcriptPath: string
): Promise<void> {
  if (accumulator.cwd && accumulator.createdAt && accumulator.updatedAt && accumulator.title) {
    return
  }
  const meta = await readCursorChatMeta(transcriptPath)
  if (!meta) {
    return
  }
  accumulator.title ??= meta.title
  accumulator.cwd ??= meta.cwd
  accumulator.createdAt ??= meta.createdAt
  accumulator.updatedAt ??= meta.updatedAt
}

async function parseCursorSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  enrichFromChatMeta?: boolean
}): Promise<AiVaultSession | null> {
  const state = createCursorSessionResumeState(args.file, args.enrichFromChatMeta ?? true)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
