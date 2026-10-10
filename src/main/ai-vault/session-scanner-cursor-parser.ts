import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
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
  addPreviewContent,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { resolveCursorTranscriptCwd } from './session-scanner-cursor-project-cwd'
import {
  asRecord,
  extractContentText,
  extractMessageText,
  extractString,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseCursorSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseCursorSessionLines({ file, lines, platform, messages })
}

export async function parseCursorSessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseCursorSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
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
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({
      agent: 'cursor',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    consumeCursorRecordLine
  )
}

async function parseCursorSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createCursorSessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  const session = await state.finalize(args.platform, args.options)
  if (!session) {
    return null
  }
  if (!session.cwd) {
    const legacyCwd = await resolveCursorTranscriptCwd(args.file.path)
    if (legacyCwd) {
      return {
        ...session,
        cwd: legacyCwd,
        resumeCommand: buildAiVaultResumeCommand({
          agent: session.agent,
          sessionId: session.sessionId,
          resumeFilePath: session.filePath,
          cwd: legacyCwd,
          platform: args.platform
        })
      }
    }
  }
  return session
}
