import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  CLAUDE_CUSTOM_TITLE_RECORD_MARKER,
  findClaudeSessionRenameRecord,
  readClaudeSessionRenamedTitle,
  type ClaudeSessionRenameRecord
} from '../shared/agent-session-rename-title'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'

// Why: Claude re-appends the rename record on most turns, so measured against
// real transcripts (2.8 MB / 37 records, newest 403 B from EOF) a short tail
// answers nearly every scan. A rename that is never re-appended still exists
// only once, near the top, so an empty tail widens to a full scan.
const TRANSCRIPT_TAIL_SCAN_BYTES = 256 * 1024
// Why: a rename record is one short line anywhere in the transcript, so the scan
// streams the file rather than buffering it. Very long sessions are tail-scanned
// from this offset; a rename that old is already superseded by the tab's
// persisted value.
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024
const MAX_REMOTE_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024

export type AgentSessionRenamedTitleArgs = {
  transcriptPath: string
  /** SSH connection owning the transcript; omitted for local/WSL panes. */
  connectionId?: string
}

/**
 * The deliberate rename (Claude `/rename`) recorded in one agent transcript, or
 * null when the session has none. Best-effort: any read failure resolves null so
 * the tab keeps its generated title instead of the call rejecting.
 */
export async function readAgentSessionRenamedTitle(
  args: AgentSessionRenamedTitleArgs
): Promise<string | null> {
  const transcriptPath = args.transcriptPath.trim()
  if (!transcriptPath) {
    return null
  }
  const connectionId = args.connectionId?.trim()
  try {
    return connectionId
      ? await readRemoteRenamedTitle(transcriptPath, connectionId)
      : await readLocalRenamedTitle(transcriptPath)
  } catch {
    return null
  }
}

async function readLocalRenamedTitle(transcriptPath: string): Promise<string | null> {
  const { size } = await stat(transcriptPath)
  const tailStart = Math.max(0, size - TRANSCRIPT_TAIL_SCAN_BYTES)
  const fromTail = await scanTranscriptFrom(transcriptPath, tailStart)
  if (fromTail || tailStart === 0) {
    return fromTail?.customTitle ?? null
  }
  const widened = await scanTranscriptFrom(
    transcriptPath,
    Math.max(0, size - MAX_TRANSCRIPT_SCAN_BYTES)
  )
  return widened?.customTitle ?? null
}

async function scanTranscriptFrom(
  transcriptPath: string,
  start: number
): Promise<ClaudeSessionRenameRecord | null> {
  const stream = createReadStream(transcriptPath, { encoding: 'utf8', start })
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    return findClaudeSessionRenameRecord(await collectLines(lines))
  } finally {
    stream.destroy()
  }
}

async function collectLines(lines: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = []
  for await (const line of lines) {
    if (line.includes(CLAUDE_CUSTOM_TITLE_RECORD_MARKER)) {
      collected.push(line)
    }
  }
  return collected
}

async function readRemoteRenamedTitle(
  transcriptPath: string,
  connectionId: string
): Promise<string | null> {
  // Why: SSH-hosted agents write the transcript on the remote host, so the local
  // filesystem has nothing to scan. No provider (disconnected) degrades to null.
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider) {
    return null
  }
  // Why: the remote read has no tail seek, so cap it well below the local budget
  // rather than pulling a long session over the link for one short record.
  const { size } = await provider.stat(transcriptPath)
  if (size > MAX_REMOTE_TRANSCRIPT_READ_BYTES) {
    return null
  }
  const { content, isBinary } = await provider.readFile(transcriptPath)
  if (isBinary || !content) {
    return null
  }
  return readClaudeSessionRenamedTitle(content.split('\n'))
}
