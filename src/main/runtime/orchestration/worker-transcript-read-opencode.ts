import type { AgentType } from '../../../shared/native-chat-types'
import {
  readOpenCodeTranscriptPageAfterViaWorker,
  readOpenCodeTranscriptPageViaWorker,
  readOpenCodeTranscriptSignalViaWorker
} from '../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { resolveOpenCodeTranscriptDbPath } from '../../native-chat/transcript-opencode'
import type {
  OpenCodeTranscriptForwardPage,
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from '../../native-chat/transcript-opencode-sqlite-query'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'

// Why: OpenCode's transcript is a SQLite DB, not a JSONL file, so its worker
// read cannot share the line-decoder/file-offset machinery. Rowids are the
// byte-offset equivalent: the initial page returns the newest window with a
// max-rowid cursor; continuations walk strictly newer rows. Kept in its own
// module so the JSONL reader stays under the repo's file-size cap.

/** OpenCode reads ride the shared SQLite worker; injectable so tests run against
 *  a temp DB without spawning the worker bundle. */
export type OpenCodeWorkerTranscriptDeps = {
  resolveDbPath?: () => Promise<string | null>
  readSignal?: (dbPath: string, sessionId: string) => Promise<OpenCodeTranscriptSignal | null>
  readPage?: (args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeMessageRowId?: number
  }) => Promise<OpenCodeTranscriptPage | null>
  readPageAfter?: (args: {
    dbPath: string
    sessionId: string
    afterMessageRowId: number
    limit: number
    upToMessageRowId?: number
  }) => Promise<OpenCodeTranscriptForwardPage | null>
}

export async function readOpenCodeWorkerTranscript(
  args: {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    offset?: number
    endOffset?: number
    limit?: number
  },
  deps: OpenCodeWorkerTranscriptDeps = {}
): Promise<WorkerTranscriptReadResult> {
  // `transcriptPath` is deliberately ignored: DB discovery is owned by the
  // SQLite reader, and every read stays on the shared OpenCode worker thread.
  const resolveDbPath = deps.resolveDbPath ?? resolveOpenCodeTranscriptDbPath
  const readSignal =
    deps.readSignal ??
    ((dbPath: string, sessionId: string) =>
      readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId }))
  const readPage = deps.readPage ?? readOpenCodeTranscriptPageViaWorker
  const readPageAfter = deps.readPageAfter ?? readOpenCodeTranscriptPageAfterViaWorker
  const limit = clampWorkerTranscriptLimit(args.limit)

  let dbPath: string | null
  try {
    dbPath = await resolveDbPath()
  } catch {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  if (!dbPath) {
    return { ok: false, reason: 'transcript_missing', warnings: [] }
  }

  try {
    const signal = await readSignal(dbPath, args.sessionId)
    if (!signal) {
      return { ok: false, reason: 'transcript_missing', warnings: [] }
    }
    // Why: rowids only move up, so a max below the frozen boundary means the DB
    // was rebuilt (rowids reset) — the pinned source changed, like a shrunken file.
    if (args.endOffset !== undefined && signal.maxMessageRowId < args.endOffset) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    // Parity with the JSONL reader's `startOffset > fileSize` check: a cursor
    // above the session's current max means those rows are gone (rebuilt DB),
    // not merely unread — an unpinned continuation must not stall silently.
    if (args.offset !== undefined && signal.maxMessageRowId < args.offset) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }

    if (args.offset === undefined) {
      const page = await readPage({
        dbPath,
        sessionId: args.sessionId,
        limit,
        // A frozen boundary pages the newest rows at or below it.
        ...(args.endOffset !== undefined ? { beforeMessageRowId: args.endOffset + 1 } : {})
      })
      if (!page) {
        return { ok: false, reason: 'transcript_missing', warnings: [] }
      }
      const bounded = boundWorkerTranscriptMessages(
        page.items.map((item) => item.message),
        dbPath
      )
      return {
        ok: true,
        filePath: dbPath,
        messages: bounded.messages,
        // Newest RAW rowid (covers non-renderable rows), maxed with the page's
        // newest — a row can interleave between readSignal and readPage.
        nextOffset:
          args.endOffset ?? Math.max(signal.maxMessageRowId, page.items.at(-1)?.rowid ?? 0),
        limited: page.hasMore || bounded.limited,
        warnings: bounded.warnings
      }
    }

    const forward = await readPageAfter({
      dbPath,
      sessionId: args.sessionId,
      afterMessageRowId: args.offset,
      limit,
      ...(args.endOffset !== undefined ? { upToMessageRowId: args.endOffset } : {})
    })
    if (!forward) {
      return { ok: false, reason: 'transcript_missing', warnings: [] }
    }
    const bounded = boundWorkerTranscriptMessages(
      forward.items.map((item) => item.message),
      dbPath
    )
    return {
      ok: true,
      filePath: dbPath,
      messages: bounded.messages,
      nextOffset: forward.nextMessageRowId,
      limited: forward.hasMore || bounded.limited,
      warnings: bounded.warnings
    }
  } catch {
    // Worker unavailability/timeout/crash — this read is retryable, not a parse
    // verdict on the transcript itself.
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
}
