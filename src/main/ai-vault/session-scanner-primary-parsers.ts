import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { normalizePromptField } from '../../shared/agent-status-field-normalization'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorSessionIdentity,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import { extractFullFirstUserPromptText } from './session-scanner-first-user-prompt'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import {
  asRecord,
  claudeUsageTotal,
  extractMessageText,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export type ClaudeSessionParseState = {
  accumulator: SessionAccumulator
  metaTitle: string | null
  generatedTitle: string | null
  firstUserTitle: string | null
  conversationContent: NonNullable<AiVaultSession['conversationContent']>
}

export function createClaudeSessionParseState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ClaudeSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'claude',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    metaTitle: null,
    generatedTitle: null,
    firstUserTitle: null,
    conversationContent: 'empty'
  }
}

export function cloneClaudeSessionParseState(
  state: ClaudeSessionParseState
): ClaudeSessionParseState {
  return {
    accumulator: {
      ...state.accumulator,
      previewMessages: [...state.accumulator.previewMessages]
    },
    metaTitle: state.metaTitle,
    generatedTitle: state.generatedTitle,
    firstUserTitle: state.firstUserTitle,
    conversationContent: state.conversationContent
  }
}

export function consumeClaudeSessionLine(state: ClaudeSessionParseState, line: string): void {
  const record = parseJsonObject(line)
  if (record) {
    consumeClaudeSessionRecord(state, record)
  } else if (line.trim() && state.conversationContent !== 'present') {
    state.conversationContent = 'unknown'
  }
}

export function consumeClaudeSessionRecord(
  state: ClaudeSessionParseState,
  record: Record<string, unknown>
): void {
  const { accumulator } = state

  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    accumulator.sessionId = record.sessionId.trim()
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  updateLatestLocation(accumulator, record)

  if (record.type === 'custom-title') {
    accumulator.title = normalizeTitleText(extractString(record.customTitle) ?? '')
    return
  }

  if (record.type === 'ai-title') {
    const title = normalizeTitleText(extractString(record.aiTitle) ?? '')
    if (title) {
      state.generatedTitle = title
    }
    return
  }

  if (record.type === 'agent-name') {
    if (!state.generatedTitle) {
      state.metaTitle ??= normalizeTitleText(extractString(record.agentName) ?? '')
    }
    return
  }

  if (record.type === 'mode' || record.type === 'permission-mode') {
    return
  }

  if (record.type === 'queue-operation') {
    // Track recoverable queued content separately from turns; uncounted empty enqueues can make removals undercount.
    if (record.operation === 'enqueue' && (extractString(record.content)?.trim().length ?? 0) > 0) {
      accumulator.queuedMessageCount++
    } else if (record.operation === 'remove' || record.operation === 'dequeue') {
      accumulator.queuedMessageCount = Math.max(0, accumulator.queuedMessageCount - 1)
    }
    return
  }

  if (record.type === 'last-prompt') {
    const prompt = normalizePromptField(record.lastPrompt)
    if (prompt) {
      accumulator.lastUserPrompt = prompt
      state.conversationContent = 'present'
    }
    return
  }

  if (record.type === 'user') {
    accumulator.messageCount++
    const title = extractMessageText(record.message)
    // Known injected tags may lack isMeta; custom tags must remain real prompts rather than fallback titles.
    const isMetaUserTurn =
      record.isMeta === true || (title != null && isKnownHarnessInjectedUserTurnText(title))
    addSessionContent(accumulator, 'user', asRecord(record.message)?.content, record.timestamp, {
      seedFirstUserPrompt: !isMetaUserTurn
    })
    if (!isMetaUserTurn) {
      state.conversationContent = 'present'
      const prompt = extractFullFirstUserPromptText(asRecord(record.message)?.content)
      state.firstUserTitle ??= prompt ? normalizeTitleText(prompt) : null
    }
    return
  }

  if (record.type === 'assistant') {
    state.conversationContent = 'present'
    accumulator.messageCount++
    const message = asRecord(record.message)
    addSessionContent(accumulator, 'assistant', message?.content, record.timestamp)
    const model = extractString(message?.model)
    if (model) {
      accumulator.model = model
    }
    accumulator.totalTokens += claudeUsageTotal(message?.usage)
    return
  }
  if (state.conversationContent !== 'present') {
    state.conversationContent = 'unknown'
  }
}

export async function finalizeClaudeSessionParseState(
  state: ClaudeSessionParseState,
  platform: NodeJS.Platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  // Detach previews so later appends cannot mutate a published session.
  const snapshot = cloneClaudeSessionParseState(state)
  // Explicit custom titles win, then generated names, real prompts and agent names.
  snapshot.accumulator.fallbackTitle =
    snapshot.generatedTitle ?? snapshot.firstUserTitle ?? snapshot.metaTitle
  // Count only on the transcript-owning host; runtime hosts stamp identity after parsing, while SSH walks supply counts.
  const ownsTranscriptDisk =
    !options.executionHostId || options.executionHostId === LOCAL_EXECUTION_HOST_ID
  if (ownsTranscriptDisk) {
    snapshot.accumulator.subagentTranscriptCount = await countSubagentTranscripts(
      snapshot.accumulator.filePath
    )
  }
  const session = finalizeSession(snapshot.accumulator, platform, options)
  return session
    ? {
        ...session,
        conversationContent:
          session.queuedMessageCount > 0 || session.subagentTranscriptCount > 0
            ? 'present'
            : snapshot.conversationContent
      }
    : null
}

export function createClaudeSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return claudeResumeStateFromParseState(createClaudeSessionParseState(file, messages))
}

function claudeResumeStateFromParseState(
  state: ClaudeSessionParseState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeClaudeSessionLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => claudeResumeStateFromParseState(cloneClaudeSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeClaudeSessionParseState(state, platform, options)
  }
}

export async function parseClaudeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseClaudeSessionLines({ file, lines, platform, messages })
}

export async function parseClaudeSessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseClaudeSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
}

async function parseClaudeSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createClaudeSessionParseState(args.file, args.messages)
  for await (const line of args.lines) {
    consumeClaudeSessionLine(state, line)
  }
  return finalizeClaudeSessionParseState(state, args.platform, args.options)
}
