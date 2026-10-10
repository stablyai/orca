import { basename } from 'node:path'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  arrayValue,
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  messages?: TranscriptMessageSink
}

// Kiro CLI keeps each session as <id>.json (metadata) beside <id>.jsonl (transcript),
// flat under $KIRO_HOME/sessions/cli; per-session subdirectories hold task state only.
// This is the `kiro-cli chat` store Orca launches; the opt-in V3 engine's own store is
// read by session-scanner-kiro-v3-parser.ts.
const KIRO_SESSION_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i

export function isKiroSessionMetadataPath(filePath: string): boolean {
  return KIRO_SESSION_FILE_PATTERN.test(basename(filePath))
}

export function kiroTranscriptPathForMetadata(filePath: string): string {
  return filePath.endsWith('.json') ? `${filePath}l` : ''
}

/** Kiro's `{ kind, data }` blocks restated as the Claude-shaped blocks the previewer reads. */
function toPreviewBlocks(content: unknown): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = []
  for (const value of arrayValue(content)) {
    const block = asRecord(value)
    const data = block?.data
    switch (block?.kind) {
      case 'text':
        if (typeof data === 'string' && data) {
          blocks.push({ type: 'text', text: data })
        }
        break
      case 'json':
        blocks.push({ type: 'text', text: JSON.stringify(data) })
        break
      case 'toolUse': {
        const tool = asRecord(data)
        blocks.push({ type: 'tool_use', name: extractString(tool?.name), input: tool?.input })
        break
      }
      case 'toolResult':
        blocks.push({ type: 'tool_result', content: toPreviewBlocks(asRecord(data)?.content) })
        break
      // thinking and image blocks carry nothing the history list shows.
      default:
        break
    }
  }
  return blocks
}

function consumeKiroTranscriptLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  const data = asRecord(record?.data)
  if (!record || !data) {
    return
  }
  const content = toPreviewBlocks(data.content)
  switch (record.kind) {
    case 'Prompt': {
      const timestamp = asRecord(data.meta)?.timestamp
      updateTimeline(accumulator, timestamp)
      accumulator.messageCount++
      addPreviewContent(accumulator, 'user', content, timestamp)
      break
    }
    case 'AssistantMessage':
      accumulator.messageCount++
      addPreviewContent(accumulator, 'assistant', content)
      break
    case 'ToolResults':
      addPreviewContent(accumulator, 'tool', content)
      break
    default:
      break
  }
}

/** null for a subagent's child session: it is reached from its parent, not listed. */
function createKiroAccumulator(
  file: FileWithMtime,
  metadataContent: string,
  messages?: TranscriptMessageSink
): SessionAccumulator | null {
  const metadata = parseJsonObject(metadataContent)
  if (!metadata || extractString(metadata.parent_session_id)) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'kiro',
    file,
    // The scanner only admits UUID file names, so the basename is the safe resume id.
    sessionId: basename(file.path, '.json'),
    messages
  })
  accumulator.cwd = extractString(metadata.cwd)
  accumulator.title = normalizeTitleText(extractString(metadata.title) ?? '') || null
  const state = asRecord(metadata.session_state)
  accumulator.model = extractString(
    asRecord(asRecord(state?.rts_model_state)?.model_info)?.model_id
  )
  updateTimeline(accumulator, metadata.created_at)
  updateTimeline(accumulator, metadata.updated_at)
  return accumulator
}

export async function parseKiroSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const accumulator = createKiroAccumulator(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan'),
    messages
  )
  if (!accumulator) {
    return null
  }
  try {
    // Why streamed: Kiro transcripts embed whole tool outputs and reach megabytes.
    const { trailingPartialLine } = await consumeCompleteJsonlLines({
      path: kiroTranscriptPathForMetadata(file.path),
      start: 0,
      onLine: (line) => consumeKiroTranscriptLine(accumulator, line)
    })
    // A torn final write fails JSON parsing and is dropped; a complete one still counts.
    if (trailingPartialLine) {
      consumeKiroTranscriptLine(accumulator, trailingPartialLine)
    }
  } catch (error) {
    // The metadata is written before the first turn; a missing transcript is a valid
    // empty session, while a WSL gate refusal must stay visible.
    if (error instanceof WslTranscriptFsError || !isMissingPathError(error)) {
      throw error
    }
  }
  return finalizeSession(accumulator, platform)
}

/** Remote/whole-content form: `transcriptLines` is null when the transcript is absent. */
export async function parseKiroSessionContent(
  file: FileWithMtime,
  metadataContent: string,
  transcriptLines: Iterable<string> | AsyncIterable<string> | null,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  const accumulator = createKiroAccumulator(file, metadataContent, options.messages)
  if (!accumulator) {
    return null
  }
  if (transcriptLines) {
    for await (const line of transcriptLines) {
      consumeKiroTranscriptLine(accumulator, line)
    }
  }
  return finalizeSession(accumulator, platform, options)
}

function isMissingPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}
