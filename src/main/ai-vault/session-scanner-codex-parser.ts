import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession
} from './session-scanner-accumulator'
import { codexRolloutBaseName } from './session-scanner-codex-paths'
import {
  consumeCodexRecordLine,
  type CodexSessionParseState
} from './session-scanner-codex-record-consume'
import { iterateCodexRolloutLines } from './session-scanner-codex-rollout-read'
import type {
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState
} from './session-scanner-types'

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null> {
  const lines = iterateCodexRolloutLines(file.path)
  try {
    return await parseCodexSessionLines({
      file,
      lines,
      platform,
      codexHome,
      executionHostId,
      titleReader: (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId)
    })
  } finally {
    lines.close()
  }
}

export async function parseCodexSessionContent(args: {
  file: FileWithMtime
  content: string
  platform?: NodeJS.Platform
  codexHome?: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
}): Promise<AiVaultSession | null> {
  return parseCodexSessionLines({
    file: args.file,
    lines: args.content.split(/\r?\n/),
    platform: args.platform ?? process.platform,
    codexHome: args.codexHome ?? null,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform,
    titleReader: args.readIndexedTitle
  })
}

function createCodexParseState(file: FileWithMtime): CodexSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'codex',
      file,
      sessionId: sessionIdFromCodexRolloutPath(file.path)
    }),
    previousTotals: null,
    rejectedWorkerSession: false,
    sawSessionMeta: false,
    titleSource: null
  }
}

function sessionIdFromCodexRolloutPath(filePath: string): string {
  const baseName = codexRolloutBaseName(filePath)
  const match = baseName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match?.[0] ?? baseName
}

function cloneCodexParseState(state: CodexSessionParseState): CodexSessionParseState {
  return {
    // previousTotals snapshots are replaced, never mutated, so sharing is safe.
    ...state,
    accumulator: cloneSessionAccumulator(state.accumulator)
  }
}

async function finalizeCodexParseState(
  state: CodexSessionParseState,
  platform: NodeJS.Platform,
  args: {
    codexHome: string | null
    titleReader?: (sessionId: string) => Promise<string | null>
    executionHostId?: ExecutionHostId
    executionHostPlatform?: NodeJS.Platform | null
  }
): Promise<AiVaultSession | null> {
  if (state.rejectedWorkerSession) {
    return null
  }
  // Finalize a snapshot: the live state keeps accumulating appended lines.
  const snapshot = cloneCodexParseState(state)
  // Why: Codex names threads lazily in session_index.jsonl, so the lookup runs
  // per finalize (the index read is signature-cached) — a title that appears
  // after the transcript was first parsed must still replace the raw prompt.
  if (snapshot.sawSessionMeta && snapshot.titleSource !== 'meta') {
    const indexedTitle = await args.titleReader?.(snapshot.accumulator.sessionId)
    if (indexedTitle) {
      snapshot.accumulator.title = indexedTitle
    }
  }
  return finalizeSession(snapshot.accumulator, platform, {
    codexHome: args.codexHome,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}

export function createCodexSessionResumeState(
  file: FileWithMtime,
  codexHome: string | null
): ResumableSessionParseState {
  return codexResumeStateFromParseState(createCodexParseState(file), codexHome, (sessionId) =>
    readCodexSessionIndexTitle(file.path, codexHome, sessionId)
  )
}

function codexResumeStateFromParseState(
  state: CodexSessionParseState,
  codexHome: string | null,
  titleReader: (sessionId: string) => Promise<string | null>
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeCodexRecordLine(state, line),
    clone: () =>
      codexResumeStateFromParseState(cloneCodexParseState(state), codexHome, titleReader),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options?: ResumableParseFinalizeOptions) =>
      finalizeCodexParseState(state, platform, { codexHome, titleReader, ...options })
  }
}

async function parseCodexSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  codexHome: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  titleReader?: (sessionId: string) => Promise<string | null>
}): Promise<AiVaultSession | null> {
  const state = createCodexParseState(args.file)
  for await (const line of args.lines) {
    consumeCodexRecordLine(state, line)
    if (state.rejectedWorkerSession) {
      // Worker transcripts are excluded outright; stop reading early.
      return null
    }
  }
  return finalizeCodexParseState(state, args.platform, {
    codexHome: args.codexHome,
    titleReader: args.titleReader,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}
