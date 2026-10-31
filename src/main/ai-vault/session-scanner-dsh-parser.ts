import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readTranscriptSlice, transcriptFileStat } from '../native-chat/wsl-transcript-fs-access'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { DSH_ZSTD_SESSION_FILE_SUFFIX, dshSessionIdFromFilePath } from './session-scanner-dsh-paths'
import { decompressZstdFrames } from './session-scanner-dsh-zstd-frames'
import { tokenTotal } from './session-scanner-token-values'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  arrayValue,
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

// User-role turns DSH injects itself (agent-instructions, runtime-context,
// skill-catalog, subagent-settled, ...) carry another source kind.
const DSH_TYPED_USER_SOURCE_KIND = 'user'
// A title the model or the user chose outranks the first-prompt stub DSH writes up front.
const DSH_FALLBACK_TITLE_SOURCE_KIND = 'fallback'
// Reasoning leads each step, so keeping it would fill the short preview with chain-of-thought.
const DSH_REASONING_BLOCK_TYPE = 'reasoning'

type DshFoldState = {
  // Null until the header line is read; false excludes the whole session.
  isTopLevel: boolean | null
  title: string | null
  titleIsFallback: boolean
}

/** Subagent sessions resume only through their parent, so they stay out of the top-level list. */
function isTopLevelDshSessionHeader(header: Record<string, unknown>): boolean {
  if (header.origin === 'subagent' || extractString(header.parentSession)) {
    return false
  }
  return !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

function foldDshHeader(
  accumulator: SessionAccumulator,
  state: DshFoldState,
  header: Record<string, unknown>
): void {
  state.isTopLevel = isTopLevelDshSessionHeader(header)
  accumulator.sessionId = extractString(header.id) ?? accumulator.sessionId
  accumulator.cwd ??= extractString(header.cwd)
  updateTimeline(accumulator, header.createdAt)
}

function foldDshTitle(state: DshFoldState, data: Record<string, unknown>): void {
  const title = extractString(data.title)
  if (!title) {
    return
  }
  const isFallback = asRecord(data.source)?.kind === DSH_FALLBACK_TITLE_SOURCE_KIND
  // Latest wins, except that a later fallback never replaces a chosen title.
  if (isFallback && state.title && !state.titleIsFallback) {
    return
  }
  state.title = title
  state.titleIsFallback = isFallback
}

function foldDshUserMessage(
  accumulator: SessionAccumulator,
  data: Record<string, unknown>,
  time: unknown
): void {
  if (asRecord(data.source)?.kind !== DSH_TYPED_USER_SOURCE_KIND) {
    return
  }
  accumulator.messageCount++
  const firstText = arrayValue(data.content)
    .map((block) => extractString(asRecord(block)?.text))
    .find((text) => text !== null)
  if (firstText) {
    accumulator.fallbackTitle ??= normalizeTitleText(firstText)
  }
  addPreviewContent(accumulator, 'user', data.content, time)
}

function foldDshAssistantMessage(
  accumulator: SessionAccumulator,
  data: Record<string, unknown>,
  time: unknown
): void {
  const message = asRecord(data.message)
  accumulator.totalTokens += tokenTotal(data.usage)
  const content = arrayValue(message?.content).filter(
    (block) => asRecord(block)?.type !== DSH_REASONING_BLOCK_TYPE
  )
  // Tool-call-only steps are not turns a reader recognizes as replies.
  if (!content.some((block) => asRecord(block)?.type === 'text')) {
    return
  }
  accumulator.messageCount++
  addPreviewContent(accumulator, 'assistant', content, time)
}

function foldDshLine(accumulator: SessionAccumulator, state: DshFoldState, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  if (record.type === 'session') {
    foldDshHeader(accumulator, state, record)
    return
  }
  updateTimeline(accumulator, record.time)
  const data = asRecord(record.data)
  if (!data) {
    return
  }
  switch (record.type) {
    case 'user/message':
      foldDshUserMessage(accumulator, data, record.time)
      break
    case 'assistant/message':
      foldDshAssistantMessage(accumulator, data, record.time)
      break
    case 'session/title':
      foldDshTitle(state, data)
      break
    case 'request/header':
      accumulator.model =
        extractString(asRecord(asRecord(data.header)?.config)?.model) ?? accumulator.model
      break
    default:
      break
  }
}

/** Fold one DSH session's decoded JSONL; null for subagent sessions and headerless files. */
export function parseDshSessionLines(
  file: FileWithMtime,
  lines: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const accumulator = createAccumulator({
    agent: 'dsh',
    file,
    sessionId: dshSessionIdFromFilePath(file.path),
    messages
  })
  const state: DshFoldState = {
    isTopLevel: null,
    title: null,
    titleIsFallback: false
  }
  for (const line of lines) {
    foldDshLine(accumulator, state, line)
    if (state.isTopLevel === false) {
      return null
    }
  }
  if (state.isTopLevel === null) {
    return null
  }
  // DSH's fallback title is a truncated stub of the first prompt; the normalized prompt reads better.
  if (state.title && !state.titleIsFallback) {
    accumulator.title = state.title
  } else {
    accumulator.fallbackTitle ??= state.title
  }
  return finalizeSession(accumulator, platform)
}

async function readDshSessionBytes(path: string): Promise<Buffer> {
  // Why: the gated readfile only returns text; a WSL path reads binary through a sliced read.
  if (!isWslUncPath(path)) {
    return readFile(path)
  }
  const { size } = await transcriptFileStat(path, 'scan')
  return readTranscriptSlice(path, 0, size, 'scan')
}

function* decodedDshLines(path: string, bytes: Buffer): Generator<string> {
  const chunks = path.endsWith(DSH_ZSTD_SESSION_FILE_SUFFIX) ? decompressZstdFrames(bytes) : [bytes]
  // Why: a frame boundary may split a multibyte character.
  const decoder = new StringDecoder('utf8')
  let carry = ''
  for (const chunk of chunks) {
    const lines = (carry + decoder.write(chunk)).split('\n')
    carry = lines.pop() ?? ''
    yield* lines
  }
  // A final line without its newline is a record still being written.
}

export async function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const bytes = await readDshSessionBytes(file.path)
  return parseDshSessionLines(file, decodedDshLines(file.path, bytes), platform, messages)
}
