import { readZcodeSqliteTranscriptViaWorker } from '../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { resolveZcodeSqliteDbPath } from '../../ai-vault/zcode-sqlite-transcript'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'
import { readLocalTranscriptSourceIdentity } from './worker-transcript-local-checkpoint'
import { createWorkerTranscriptBoundaryCheckpoint } from './worker-transcript-source-identity'

export async function readZcodeWorkerTranscript(args: {
  sessionId: string
  transcriptPath?: string
  offset?: number
  limit?: number
  expectedSourceFingerprint?: string
  expectedBoundaryCheckpoint?: string
}): Promise<WorkerTranscriptReadResult> {
  const dbPath = resolveZcodeSqliteDbPath(args.transcriptPath)
  try {
    const before = await readLocalTranscriptSourceIdentity(dbPath)
    if (
      !before ||
      (args.expectedSourceFingerprint && args.expectedSourceFingerprint !== before.fingerprint)
    ) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const expectedCheckpoint =
      args.offset === undefined ? undefined : checkpoint(args.sessionId, args.offset)
    if (
      args.expectedBoundaryCheckpoint !== undefined &&
      args.expectedBoundaryCheckpoint !== expectedCheckpoint
    ) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const page = await readZcodeSqliteTranscriptViaWorker({
      dbPath,
      sessionId: args.sessionId,
      offset: args.offset,
      limit: clampWorkerTranscriptLimit(args.limit)
    })
    const after = await readLocalTranscriptSourceIdentity(dbPath)
    if (!after || after.fingerprint !== before.fingerprint) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const bounded = boundWorkerTranscriptMessages(page.messages, dbPath)
    return {
      ok: true,
      filePath: dbPath,
      sourceFingerprint: before.fingerprint,
      boundaryCheckpoint: checkpoint(args.sessionId, page.nextOffset),
      messages: bounded.messages,
      nextOffset: page.nextOffset,
      limited: page.limited || bounded.limited,
      clipping: [
        ...(page.limited ? ['message_limit_or_scan_window'] : []),
        ...(bounded.limited ? ['transcript_payload'] : [])
      ],
      warnings: [...page.warnings, ...bounded.warnings]
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ZCODE_TRANSCRIPT_SOURCE_CHANGED')) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason:
        code === 'ENOENT' || message.includes('does not exist')
          ? 'transcript_missing'
          : code === 'EACCES' || code === 'EPERM'
            ? 'transcript_unreadable'
            : 'transcript_parse_failed',
      warnings: []
    }
  }
}

function checkpoint(sessionId: string, offset: number): string {
  return createWorkerTranscriptBoundaryCheckpoint(Buffer.from(`${sessionId}\0${offset}`, 'utf8'))
}
