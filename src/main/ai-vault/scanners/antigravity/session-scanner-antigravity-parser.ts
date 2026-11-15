import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from '../../transcripts/remote-session-content-lines'
import { consumeCompleteJsonlLines } from '../../parsing/session-scanner-jsonl-reader'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../../transcripts/session-transcript-record-budget'
import type {
  AiVaultSession,
  AiVaultSessionTitleKind
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  timestampIso,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionText } from '../../parsing/session-scanner-messages'
import { waitForAiVaultScan } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'
import { antigravityHistoryPromptHash } from './antigravity-history-prompt'
import { readAntigravityMetadataTitle } from './session-scanner-antigravity-title-index'
import type {
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import { extractString } from '../../../../shared/trimmed-string'
import { parseJsonObject } from '../../parsing/session-json-object'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'

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
    options,
    enableLocalTitleIndex: false
  })
}

export function createAntigravitySessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  const sessionId = antigravityConversationIdFromTranscriptPath(file.path) ?? ''
  // Transcripts lack cwd/model; enrich cwd conservatively from history rather than unstable binary stores.
  return antigravityResumeStateFromAccumulator(
    createAccumulator({ agent: 'antigravity', file, sessionId, messages }),
    file,
    (id, signal) => readAntigravityMetadataTitle(file.path, id, signal)
  )
}

function antigravityResumeStateFromAccumulator(
  accumulator: SessionAccumulator,
  file: FileWithMtime,
  readTitle?: (sessionId: string, signal?: AbortSignal) => Promise<string | null>
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeAntigravityRecordLine(accumulator, line),
    identity: () => accumulatorSessionIdentity(accumulator),
    clone: () =>
      antigravityResumeStateFromAccumulator(cloneSessionAccumulator(accumulator), file, readTitle),
    touchFile: (nextFile) => {
      accumulator.modifiedAt = nextFile.modifiedAt
    },
    // Snapshot so appends cannot change published previews and sidecar merges stay outside the live fold.
    finalize: (platform, options) =>
      finalizeAntigravityAccumulator(accumulator, platform, options, readTitle)
  }
}

async function finalizeAntigravityAccumulator(
  accumulator: SessionAccumulator,
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions | undefined,
  readTitle?: (sessionId: string, signal?: AbortSignal) => Promise<string | null>
): Promise<AiVaultSession | null> {
  const snapshot = cloneSessionAccumulator(accumulator)
  const sessionId = snapshot.sessionId.trim()
  let titleKind: AiVaultSessionTitleKind = 'fallback'
  if (sessionId && readTitle) {
    const indexedTitle = await waitForAiVaultScan(
      readTitle(sessionId, options?.signal),
      options?.signal
    )
    if (indexedTitle) {
      snapshot.title = indexedTitle
      titleKind = 'named'
    }
  }
  return finalizeSession(snapshot, platform, { ...options, titleKind })
}

async function parseAntigravitySessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
  enableLocalTitleIndex?: boolean
}): Promise<AiVaultSession | null> {
  const sessionId = antigravityConversationIdFromTranscriptPath(args.file.path) ?? ''
  const state =
    args.enableLocalTitleIndex === false
      ? antigravityResumeStateFromAccumulator(
          createAccumulator({
            agent: 'antigravity',
            file: args.file,
            sessionId,
            messages: args.messages
          }),
          args.file
        )
      : createAntigravitySessionResumeState(args.file, args.messages)
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
    addSessionText(accumulator, { role: 'user', text: request, timestamp: record.created_at })
    return
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content) {
    accumulator.messageCount++
    addSessionText(accumulator, {
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
