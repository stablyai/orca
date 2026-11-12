import { waitForAiVaultScan } from '../../ai-vault-scan-cancellation'
import { wslGatedReadFile } from '../../../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/wsl-transcript-fs-error'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { kiroV3TranscriptPathForManifest } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../session-scanner-accumulator'
import { addSessionContent, addSessionText } from '../../session-scanner-messages'
import { consumeCompleteJsonlLines } from '../../session-scanner-jsonl-reader'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import type { SkippedTranscriptRecord } from '../../transcripts/session-transcript-record-budget'
import { arrayValue, extractString, parseJsonObject } from '../../session-scanner-values'
import { asRecord } from '../../session-scanner-record-value'
import { normalizeTitleText } from '../../session-scanner-text-normalization'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  messages?: TranscriptMessageSink
}

// kiro-cli's opt-in V3 engine keeps each session as
// <sessions>/<workspace-hash>/sess_<uuid>/session.json beside a messages.jsonl transcript.
const KIRO_V3_MANIFEST_NAME = 'session.json'
const KIRO_V3_SESSION_DIR_PATTERN =
  /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_DIR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The manifest's `sess_<uuid>` directory, split on either separator for WSL paths. */
function kiroV3SessionDirName(filePath: string): string | null {
  const [dirName, fileName] = filePath.split(/[\\/]/).slice(-2)
  return fileName === KIRO_V3_MANIFEST_NAME && dirName && KIRO_V3_SESSION_DIR_PATTERN.test(dirName)
    ? dirName
    : null
}

export function isKiroV3SessionManifestPath(filePath: string): boolean {
  return kiroV3SessionDirName(filePath) !== null
}

/**
 * Walks only `<workspace-hash>/sess_<uuid>/`. Depth 0 skips `cli/` (the `kiro-cli chat`
 * store, scanned from its own root), UUID dirs (that store's per-session task state, met
 * when this predicate walks the `cli/` root) and dot dirs such as `.index`.
 */
export function kiroV3SessionDirectoryPredicate(name: string, depth: number): boolean {
  if (depth === 0) {
    return name !== 'cli' && !name.startsWith('.') && !UUID_DIR_PATTERN.test(name)
  }
  return depth === 1 && KIRO_V3_SESSION_DIR_PATTERN.test(name)
}

/** V3 manifests carry the workspace in `workspacePaths` instead of the chat store's `cwd`. */
export function kiroV3ManifestCwd(manifest: Record<string, unknown>): string | null {
  return arrayValue(manifest.workspacePaths).map(extractString).find(Boolean) ?? null
}

function createKiroV3Accumulator(
  file: FileWithMtime,
  manifestContent: string,
  messages?: TranscriptMessageSink
): SessionAccumulator | null {
  const manifest = parseJsonObject(manifestContent)
  const sessionId = kiroV3SessionDirName(file.path)
  if (!manifest || !sessionId) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'kiro',
    file,
    // The validated directory name rather than the manifest's `id`: it is what
    // `--resume-id` takes, and the scanner only admits `sess_<uuid>` directories.
    sessionId,
    messages
  })
  accumulator.cwd = kiroV3ManifestCwd(manifest)
  accumulator.title = normalizeTitleText(extractString(manifest.title) ?? '') || null
  accumulator.model = extractString(manifest.modelId)
  updateTimeline(accumulator, manifest.createdAt)
  updateTimeline(accumulator, manifest.lastModifiedAt)
  return accumulator
}

function consumeKiroV3TranscriptLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!record || !payload) {
    return
  }
  updateTimeline(accumulator, record.timestamp)
  if (payload.type === 'user') {
    accumulator.messageCount++
    accumulator.fallbackTitle ??= normalizeTitleText(extractString(payload.content) ?? '')
    addSessionContent(accumulator, 'user', payload.content, record.timestamp)
    return
  }
  // Why only `Say`: Kiro also logs `Reasoning` (thinking) and `Summary` (compaction) as
  // assistant entries, and neither is a reply the user saw.
  if (payload.type === 'assistant' && payload.operationType === 'Say') {
    accumulator.messageCount++
    addSessionText(accumulator, {
      role: 'assistant',
      text: extractString(payload.content),
      timestamp: record.timestamp
    })
  }
}

export async function parseKiroV3SessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  onSkippedRecords?: (records: SkippedTranscriptRecord[]) => void,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  let manifestContent: string
  try {
    manifestContent = await waitForAiVaultScan(
      wslGatedReadFile(file.path, 'utf-8', 'scan', signal),
      signal
    )
  } catch (error) {
    // Why: only a manifest that is gone is "no session". A gate refusal or a transient read
    // error (a Windows sharing violation while Kiro rewrites the file) must surface as a scan
    // issue, or the parse cache keeps the missing row under the unchanged mtime.
    if (!(error instanceof WslTranscriptFsError) && isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  const accumulator = createKiroV3Accumulator(file, manifestContent, messages)
  if (!accumulator) {
    return null
  }
  try {
    const { trailingPartialLine, skippedRecords } = await consumeCompleteJsonlLines({
      path: kiroV3TranscriptPathForManifest(file.path),
      start: 0,
      signal,
      drain: () => messages?.drain?.() ?? Promise.resolve(),
      onLine: (line) => consumeKiroV3TranscriptLine(accumulator, line)
    })
    onSkippedRecords?.(skippedRecords)
    // A torn final write fails JSON parsing and is dropped; a complete one still counts.
    if (trailingPartialLine) {
      consumeKiroV3TranscriptLine(accumulator, trailingPartialLine)
    }
  } catch (error) {
    // No transcript yet (a session opened but never prompted) is a valid empty session; any
    // other failure means the bytes exist but were unreadable, so a partial row must not cache.
    if (error instanceof WslTranscriptFsError || !isDefinitiveAbsence(error)) {
      throw error
    }
  }
  return finalizeSession(accumulator, platform)
}

/** Remote/whole-content form: `transcriptLines` is null when the transcript is absent. */
export async function parseKiroV3SessionContent(
  file: FileWithMtime,
  manifestContent: string,
  transcriptLines: Iterable<string> | AsyncIterable<string> | null,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  const accumulator = createKiroV3Accumulator(file, manifestContent, options.messages)
  if (!accumulator) {
    return null
  }
  if (transcriptLines) {
    for await (const line of transcriptLines) {
      consumeKiroV3TranscriptLine(accumulator, line)
    }
  }
  return finalizeSession(accumulator, platform, options)
}
