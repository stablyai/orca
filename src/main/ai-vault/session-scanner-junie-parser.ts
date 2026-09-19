import { createInterface } from 'node:readline'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  addPreviewMessage,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  junieSessionIdFromEventsPath,
  junieSessionIndexPathFromEventsPath,
  readJunieSummaryBySessionId
} from './session-scanner-junie-paths'
import type {
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  asRecord,
  extractString,
  normalizePreviewText,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

// Why a raw-text prefilter before JSON.parse: a real Junie transcript reaches hundreds of
// megabytes on one session, and ~94% of those bytes are repeated terminal-output snapshots
// (`TerminalBlockUpdatedEvent`) this parser never reads. Rejecting a line by substring is
// orders of magnitude cheaper than parsing it. A false positive (the needle appearing
// inside captured terminal text) only costs one wasted parse — the parsed structure is
// still what decides, so nothing incorrect can get in.
const JUNIE_EVENT_LINE_RE =
  /"kind":"(?:UserPromptEvent|ResultBlockUpdatedEvent|LlmResponseMetadataEvent|CurrentDirectoryUpdatedEvent)"/

const TIMESTAMP_KEY = '"timestampMs":'

/** Fold state beyond the accumulator; `clone` must deep-copy all of it (see ResumableSessionParseState). */
type JunieFoldState = {
  accumulator: SessionAccumulator
  /** Each result block is emitted twice (IN_PROGRESS then COMPLETED) with identical text. */
  seenResultStepIds: Set<string>
  /** Junie mixes helper models into one session; the primary is the one that wrote the most. */
  outputTokensByModel: Map<string, number>
}

// Parses a Junie `events.jsonl` transcript into an AI Vault session. Each line is a
// kotlinx-polymorphic SessionEvent discriminated by `kind` (not `type`), stamped with
// `timestampMs`; UI events nest under `event.agentEvent`. Title and cwd come from the
// shared sessions/index.jsonl, which 43% of real sessions are missing — the transcript
// backfills both.
export async function parseJunieSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const state = createJunieSessionResumeState(file)
  const input = openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      state.consumeLine(line)
    }
  } catch (error) {
    // No transcript yet (session created but never ran a turn) — metadata-only sessions
    // still belong in the panel. A gate refusal instead means the bytes exist but are
    // unreachable; a partial session must not be cached.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so a mid-read
    // failure cannot leak the gated transcript handle.
    lines.close()
    input.destroy()
  }
  return state.finalize(platform)
}

/** Incremental fold so an active multi-hundred-megabyte transcript is read once, then only appended lines. */
export function createJunieSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return junieResumeState({
    accumulator: createAccumulator({
      agent: 'junie',
      file,
      sessionId: junieSessionIdFromEventsPath(file.path)
    }),
    seenResultStepIds: new Set(),
    outputTokensByModel: new Map()
  })
}

function junieResumeState(fold: JunieFoldState): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeJunieEventLine(fold, line),
    clone: () =>
      junieResumeState({
        accumulator: cloneSessionAccumulator(fold.accumulator),
        seenResultStepIds: new Set(fold.seenResultStepIds),
        outputTokensByModel: new Map(fold.outputTokensByModel)
      }),
    touchFile: (nextFile) => {
      fold.accumulator.modifiedAt = nextFile.modifiedAt
    },
    finalize: async (platform, options) => finalizeJunieFold(fold, platform, options)
  }
}

async function finalizeJunieFold(
  fold: JunieFoldState,
  platform: NodeJS.Platform,
  options?: ResumableParseFinalizeOptions
): Promise<AiVaultSession | null> {
  // Snapshot: the live fold keeps consuming appended lines after this session is handed out.
  const accumulator = cloneSessionAccumulator(fold.accumulator)
  accumulator.model = primaryModel(fold.outputTokensByModel)

  const summary = (
    await readJunieSummaryBySessionId(junieSessionIndexPathFromEventsPath(accumulator.filePath))
  ).get(accumulator.sessionId)
  if (summary) {
    accumulator.title = normalizeTitleText(summary.taskName ?? '') || accumulator.title
    accumulator.cwd = summary.projectDir ?? accumulator.cwd
    updateTimeline(accumulator, summary.createdAt)
    updateTimeline(accumulator, summary.updatedAt)
  }
  // Why: sessions absent from index.jsonl (43% of a real home — aborted or never-titled
  // runs) have no task name and often no user turn either. The shared
  // `<agent> <first 8 chars of id>` fallback would render every one of them as the same
  // "Junie session-", since every Junie id starts with that prefix; keep the
  // distinctive timestamp instead.
  accumulator.fallbackTitle ??= normalizeTitleText(
    `Junie ${accumulator.sessionId.replace(/^session-/, '')}`
  )

  return finalizeSession(accumulator, platform, options)
}

function primaryModel(outputTokensByModel: ReadonlyMap<string, number>): string | null {
  let primary: string | null = null
  let best = -1
  for (const [model, outputTokens] of outputTokensByModel) {
    if (outputTokens > best) {
      primary = model
      best = outputTokens
    }
  }
  return primary
}

function consumeJunieEventLine(fold: JunieFoldState, line: string): void {
  // Timeline first: it is the one field every line can carry, and reading it by index is
  // cheap enough to run on the rejected 94%, which keeps index-less sessions ordered.
  foldTimestamp(fold.accumulator, line)
  if (!JUNIE_EVENT_LINE_RE.test(line)) {
    return
  }
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  if (record.kind === 'UserPromptEvent') {
    consumeUserPrompt(fold.accumulator, record)
    return
  }
  const agentEvent = asRecord(asRecord(record.event)?.agentEvent)
  switch (agentEvent?.kind) {
    case 'ResultBlockUpdatedEvent':
      consumeResultBlock(fold, agentEvent, record.timestampMs)
      return
    case 'LlmResponseMetadataEvent':
      consumeModelUsage(fold, agentEvent)
      return
    case 'CurrentDirectoryUpdatedEvent':
      // Why: the only cwd source for sessions missing from index.jsonl; without it their
      // resume command omits the `cd` and lands Junie in the wrong project.
      fold.accumulator.cwd ??= extractString(agentEvent.currentDirectory)?.trim() || null
      break
    default:
      break
  }
}

function foldTimestamp(accumulator: SessionAccumulator, line: string): void {
  const at = line.lastIndexOf(TIMESTAMP_KEY)
  if (at === -1) {
    return
  }
  const digits = line.slice(at + TIMESTAMP_KEY.length, at + TIMESTAMP_KEY.length + 16)
  const timestampMs = Number.parseInt(digits, 10)
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    updateTimeline(accumulator, timestampMs)
  }
}

function consumeUserPrompt(accumulator: SessionAccumulator, record: Record<string, unknown>): void {
  const prompt = normalizePreviewText(
    extractString(record.presentablePrompt) ?? extractString(record.prompt) ?? ''
  )
  if (!prompt) {
    return
  }
  accumulator.messageCount++
  accumulator.fallbackTitle ??= normalizeTitleText(prompt)
  addPreviewMessage(accumulator, {
    role: 'user',
    text: prompt,
    timestamp: record.timestampMs
  })
}

function consumeResultBlock(
  fold: JunieFoldState,
  agentEvent: Record<string, unknown>,
  timestamp: unknown
): void {
  const stepId = extractString(agentEvent.stepId)
  if (stepId) {
    if (fold.seenResultStepIds.has(stepId)) {
      return
    }
    fold.seenResultStepIds.add(stepId)
  }
  const text = normalizePreviewText(extractString(agentEvent.result) ?? '')
  if (!text) {
    return
  }
  fold.accumulator.messageCount++
  addPreviewMessage(fold.accumulator, { role: 'assistant', text, timestamp })
}

function consumeModelUsage(fold: JunieFoldState, agentEvent: Record<string, unknown>): void {
  const modelUsage = Array.isArray(agentEvent.modelUsage) ? agentEvent.modelUsage : []
  for (const entry of modelUsage) {
    const usage = asRecord(entry)
    if (!usage) {
      continue
    }
    const outputTokens = numberValue(usage.outputTokens)
    fold.accumulator.totalTokens +=
      numberValue(usage.inputTokens) +
      numberValue(usage.cacheInputTokens) +
      numberValue(usage.cacheCreateTokens) +
      outputTokens
    const model = extractString(usage.model)
    if (model) {
      fold.outputTokensByModel.set(model, (fold.outputTokensByModel.get(model) ?? 0) + outputTokens)
    }
  }
}
