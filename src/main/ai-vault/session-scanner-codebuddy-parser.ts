import { createInterface } from 'node:readline'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorSessionIdentity,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionText } from './session-scanner-messages'
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

// Tool and diff blocks provide no text for previews.
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
    // Injected context must not seed user prompts; skipRun marks turns never sent as user input.
    const isMetaUserTurn =
      asRecord(record.providerData)?.skipRun === true ||
      (text != null && isKnownHarnessInjectedUserTurnText(text))
    addSessionText(accumulator, {
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
    addSessionText(accumulator, { role: 'assistant', text, timestamp: record.timestamp })
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
  // Detach previews so later appends cannot mutate a published session.
  const snapshot = cloneCodebuddySessionParseState(state)
  // Prefer summary, then generated AI title, then the first user prompt.
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
