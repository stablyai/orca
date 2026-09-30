import { createInterface } from 'node:readline'
import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewMessage,
  accumulatorSessionIdentity,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// CodeBuddy stores top-level message roles and input_text/output_text blocks, not Claude records.
export type CodebuddySessionParseState = {
  accumulator: ReturnType<typeof createAccumulator>
  aiTitle: string | null
  firstUserTitle: string | null
}

export function createCodebuddySessionParseState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): CodebuddySessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'codebuddy',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    aiTitle: null,
    firstUserTitle: null
  }
}

export function cloneCodebuddySessionParseState(
  state: CodebuddySessionParseState
): CodebuddySessionParseState {
  return {
    accumulator: {
      ...state.accumulator,
      previewMessages: [...state.accumulator.previewMessages]
    },
    aiTitle: state.aiTitle,
    firstUserTitle: state.firstUserTitle
  }
}

// CodeBuddy conversation content is an array of typed text blocks; join the
// text ones. Non-text blocks (tool calls, diffs) carry no preview copy.
function codebuddyContentText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts = content
    .map((block) => {
      const record = asRecord(block)
      const type = extractString(record?.type)
      return type === 'input_text' || type === 'output_text' || type === 'text'
        ? extractString(record?.text)
        : null
    })
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
  return parts.length > 0 ? parts.join('\n\n') : null
}

export function consumeCodebuddySessionLine(state: CodebuddySessionParseState, line: string): void {
  const { accumulator } = state
  const record = parseJsonObject(line)
  if (!record) {
    return
  }

  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    accumulator.sessionId = record.sessionId.trim()
  }
  updateTimeline(accumulator, record.timestamp)
  updateLatestLocation(accumulator, record)

  // The CLI's own session title; later summaries revise it, like Claude's
  // custom-title.
  if (record.type === 'summary') {
    const summary = normalizeTitleText(extractString(record.summary) ?? '')
    if (summary) {
      accumulator.title = summary
    }
    return
  }

  if (record.type === 'ai-title') {
    const title = normalizeTitleText(extractString(record.aiTitle) ?? '')
    if (title) {
      // CodeBuddy can revise generated names; AI Vault mirrors the current one.
      state.aiTitle = title
    }
    return
  }

  if (record.type !== 'message') {
    return
  }

  const role = extractString(record.role)
  const text = codebuddyContentText(record.content)
  accumulator.messageCount++
  if (role === 'user') {
    // Meta prompts (injected context) only seed the last-resort title.
    // `providerData.skipRun` marks machinery-injected turns that never reached
    // the model as a user prompt.
    const isMetaUserTurn =
      asRecord(record.providerData)?.skipRun === true ||
      (text != null && isKnownHarnessInjectedUserTurnText(text))
    addPreviewMessage(accumulator, {
      role: 'user',
      text,
      timestamp: record.timestamp,
      seedFirstUserPrompt: !isMetaUserTurn
    })
    if (text && !isMetaUserTurn) {
      state.firstUserTitle ??= text
    }
    return
  }
  if (role === 'assistant') {
    addPreviewMessage(accumulator, { role: 'assistant', text, timestamp: record.timestamp })
    const model = extractString(asRecord(record.providerData)?.model)
    if (model) {
      accumulator.model = model
    }
  }
}

export function finalizeCodebuddySessionParseState(
  state: CodebuddySessionParseState,
  platform: NodeJS.Platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  // Finalize a snapshot: the live state (and its preview array) may keep
  // accumulating appended lines after this session object is handed out.
  const snapshot = cloneCodebuddySessionParseState(state)
  // Why: the CLI's summary title wins via accumulator.title; the generated
  // ai-title should outrank the raw first prompt when present.
  snapshot.accumulator.fallbackTitle = snapshot.aiTitle ?? snapshot.firstUserTitle
  return finalizeSession(snapshot.accumulator, platform, options)
}

function codebuddyResumeStateFromParseState(
  state: CodebuddySessionParseState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeCodebuddySessionLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => codebuddyResumeStateFromParseState(cloneCodebuddySessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeCodebuddySessionParseState(state, platform, options)
  }
}

export function createCodebuddySessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return codebuddyResumeStateFromParseState(createCodebuddySessionParseState(file, messages))
}

export async function parseCodebuddySessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseCodebuddySessionLines({ file, lines, platform, messages })
}

export async function parseCodebuddySessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseCodebuddySessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
}

async function parseCodebuddySessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createCodebuddySessionParseState(args.file, args.messages)
  for await (const line of args.lines) {
    consumeCodebuddySessionLine(state, line)
  }
  return finalizeCodebuddySessionParseState(state, args.platform, args.options)
}
