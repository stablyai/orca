import { readZcodeSqliteTranscriptViaWorker } from '../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { resolveZcodeSqliteDbPath } from '../../ai-vault/zcode-sqlite-transcript'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'

export async function readZcodeWorkerTranscript(args: {
  sessionId: string
  transcriptPath?: string
  offset?: number
  endOffset?: number
  limit?: number
}): Promise<WorkerTranscriptReadResult> {
  const dbPath = resolveZcodeSqliteDbPath(args.transcriptPath)
  try {
    const page = await readZcodeSqliteTranscriptViaWorker({
      dbPath,
      sessionId: args.sessionId,
      offset: args.offset,
      endOffset: args.endOffset,
      limit: clampWorkerTranscriptLimit(args.limit)
    })
    const bounded = boundWorkerTranscriptMessages(page.messages, dbPath)
    return {
      ok: true,
      filePath: dbPath,
      messages: bounded.messages,
      nextOffset: page.nextOffset,
      limited: page.limited || bounded.limited,
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
