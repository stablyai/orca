import { createInterface } from 'node:readline'
import type { ExecutionHostId } from '../../shared/execution-host'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { accumulatorSessionIdentity, updateTimeline } from './session-scanner-accumulator'
import {
  cloneClaudeSessionParseState,
  consumeClaudeSessionLine,
  createClaudeSessionParseState,
  finalizeClaudeSessionParseState,
  type ClaudeSessionParseState
} from './session-scanner-primary-parsers'
import { asRecord, extractString, parseJsonObject } from './session-scanner-values'
import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'

type ParserOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

function createQoderState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ClaudeSessionParseState {
  const state = createClaudeSessionParseState(file, messages)
  state.accumulator.agent = 'qoder'
  return state
}

function consumeQoderLine(state: ClaudeSessionParseState, line: string): void {
  // Qoder 1.1.64 shares Claude's turns, titles and tool blocks, with extra startup records.
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const message = asRecord(record.message)
  if (message && Array.isArray(message.content)) {
    const content = message.content.filter((block) => asRecord(block)?.type === 'text')
    consumeClaudeSessionLine(state, JSON.stringify({ ...record, message: { ...message, content } }))
  } else {
    consumeClaudeSessionLine(state, line)
  }
  if (
    record.type === 'workspace-directories' &&
    !state.accumulator.cwd &&
    Array.isArray(record.directories)
  ) {
    state.accumulator.cwd = extractString(record.directories[0])
  }
  if (record.type === 'runtime-config') {
    state.accumulator.model = extractString(record.model) ?? state.accumulator.model
    updateTimeline(state.accumulator, record.timestamp)
  }
}

function resumeState(state: ClaudeSessionParseState): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeQoderLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => resumeState(cloneClaudeSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeClaudeSessionParseState(state, platform, options)
  }
}

export function createQoderSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return resumeState(createQoderState(file, messages))
}

export async function parseQoderSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
) {
  const stream = openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    return await parseLines(file, lines, platform, {}, messages)
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function parseQoderSessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserOptions = {},
  signal?: AbortSignal
) {
  return parseLines(file, remoteSessionContentLines(content, signal), platform, options)
}

async function parseLines(
  file: FileWithMtime,
  lines: AsyncIterable<string> | Iterable<string>,
  platform: NodeJS.Platform,
  options: ParserOptions,
  messages?: TranscriptMessageSink
) {
  const state = createQoderState(file, messages)
  for await (const line of lines) {
    consumeQoderLine(state, line)
  }
  return finalizeClaudeSessionParseState(state, platform, options)
}
