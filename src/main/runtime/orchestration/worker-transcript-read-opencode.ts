import type { AgentType } from '../../../shared/native-chat-types'
import { readOpenCodeTranscriptPageAfterViaWorker } from '../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import {
  openCodeTranscriptDefaultDeps,
  type OpenCodeTranscriptDeps
} from '../../native-chat/transcript-opencode'
import type { OpenCodeTranscriptForwardPage } from '../../native-chat/transcript-opencode-sqlite-query'
import { wslGatedStat } from '../../native-chat/wsl-transcript-fs-access'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'

// Why: OpenCode's worker read cannot share the line-decoder/file-offset
// machinery. Rowids are the byte-offset equivalent: the initial page returns
// the newest window with a max-rowid cursor; continuations walk strictly
// newer rows. Kept in its own module so the JSONL reader stays under the
// repo's file-size cap.

/** OpenCode reads ride the shared SQLite worker; injectable so tests run against
 *  a temp DB without spawning the worker bundle. Extends the native-chat deps
 *  so the page/signal shapes cannot drift between the two consumers. */
export type OpenCodeWorkerTranscriptDeps = OpenCodeTranscriptDeps & {
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
    limit?: number
    /** Attested checkpoint from the cursor owner; must chain to this read's offset. */
    expectedBoundaryCheckpoint?: string
    // Note: no expectedSourceFingerprint — source identity is enforced by the
    // caller (worker-output compares sourceIdentity across reads), and this
    // module mints the fingerprint every success carries. Accepting one here
    // would invite callers to assume it is checked.
  },
  deps: OpenCodeWorkerTranscriptDeps = {}
): Promise<WorkerTranscriptReadResult> {
  // `transcriptPath` is deliberately ignored: DB discovery is owned by the
  // SQLite reader, and every read stays on the shared OpenCode worker thread.
  const resolveDbPath = deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath
  const readSignal = deps.readSignal ?? openCodeTranscriptDefaultDeps.readSignal
  const readPage = deps.readPage ?? openCodeTranscriptDefaultDeps.readPage
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
  // Why: the wire cursor re-attests the source on every read
  // (worker-output compares sourceIdentity across reads), so the fingerprint
  // must be append-stable — a rowid high-water mark would flip the identity
  // on every new message and break continuations. DB identity + session key
  // pin the source; rowid resets are caught by the max-rowid guard below.
  // File identity (not mtime/size: those move on every append) also catches
  // a same-path DB replacement whose fresh rowids regrow past the cursor —
  // the rowid guard alone cannot see that. A VACUUM rewrites the file too, so
  // it surfaces one retryable source_changed; an acceptable trade for never
  // silently serving a different DB's rows under a valid cursor.
  const sourceFingerprint = await openCodeSourceFingerprint(dbPath, args.sessionId)
  const clip = (hasMore: boolean, payloadLimited: boolean): string[] => [
    ...(hasMore ? ['message_limit_or_scan_window'] : []),
    ...(payloadLimited ? ['transcript_payload'] : [])
  ]

  try {
    const signal = await readSignal(dbPath, args.sessionId)
    if (!signal) {
      // A pinned continuation outlives its session row only when the DB was
      // rebuilt or the session deleted — the source changed, like a shrunken
      // file. An unpinned first read simply found nothing yet.
      return {
        ok: false,
        reason: args.offset !== undefined ? 'source_changed' : 'transcript_missing',
        warnings: []
      }
    }
    // Why: a poisoned cursor (NaN from a corrupt mock or a broken caller)
    // would otherwise encode "NaN"/"undefined" checkpoints that fail the
    // chain check forever — a permanent source_changed loop. Fail the read
    // instead of minting the poisoned cursor.
    if (args.offset !== undefined && !Number.isFinite(args.offset)) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    if (!Number.isFinite(signal.maxMessageRowId)) {
      return { ok: false, reason: 'transcript_unreadable', warnings: [] }
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
        limit
      })
      if (!page) {
        return { ok: false, reason: 'transcript_missing', warnings: [] }
      }
      const bounded = boundWorkerTranscriptMessages(
        page.items.map((item) => item.message),
        dbPath
      )
      // Newest RAW rowid (covers non-renderable rows), maxed with the page's
      // newest — a row can interleave between readSignal and readPage.
      const nextOffset = Math.max(signal.maxMessageRowId, page.items.at(-1)?.rowid ?? 0)
      if (!Number.isFinite(nextOffset)) {
        return { ok: false, reason: 'transcript_unreadable', warnings: [] }
      }
      return {
        ok: true,
        filePath: dbPath,
        sourceFingerprint,
        // Why: a content hash would false-positive on OpenCode's legitimate
        // in-place part backfill (parts arrive stubbed, text lands later), so
        // the checkpoint is the boundary rowid itself. It chains: the next
        // continuation's offset must equal it, and the max-rowid guard above
        // catches DB rebuilds that reset rowids.
        boundaryCheckpoint: String(nextOffset),
        messages: bounded.messages,
        nextOffset,
        limited: page.hasMore || bounded.limited,
        clipping: clip(page.hasMore, bounded.limited),
        warnings: bounded.warnings
      }
    }

    // A caller-attested checkpoint must chain to this continuation's offset —
    // a skew means the cursor and the position disagree about the boundary.
    if (
      args.expectedBoundaryCheckpoint !== undefined &&
      args.expectedBoundaryCheckpoint !== String(args.offset)
    ) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const forward = await readPageAfter({
      dbPath,
      sessionId: args.sessionId,
      afterMessageRowId: args.offset,
      limit
    })
    if (!forward) {
      // The session row vanished between the signal and forward queries —
      // same condition the signal-null pinned branch maps to source_changed;
      // transcript_missing here would sticky-kill the stream instead.
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const bounded = boundWorkerTranscriptMessages(
      forward.items.map((item) => item.message),
      dbPath
    )
    if (!Number.isFinite(forward.nextMessageRowId)) {
      return { ok: false, reason: 'transcript_unreadable', warnings: [] }
    }
    return {
      ok: true,
      filePath: dbPath,
      sourceFingerprint,
      boundaryCheckpoint: String(forward.nextMessageRowId),
      messages: bounded.messages,
      nextOffset: forward.nextMessageRowId,
      limited: forward.hasMore || bounded.limited,
      clipping: clip(forward.hasMore, bounded.limited),
      warnings: bounded.warnings
    }
  } catch {
    // Worker unavailability/timeout/crash — this read is retryable, not a parse
    // verdict on the transcript itself.
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
}

// Last stat identity per DB. A transient stat failure reuses it rather than
// flipping the fingerprint form — a form flip is an identity mismatch at the
// cursor owner (source_changed) for a source that did not change.
const openCodeDbIdentity = new Map<string, { dev: number; ino: number }>()

/**
 * Mint the append-stable source fingerprint for one DB + session.
 * File identity (dev + inode) flips on same-path replacement while surviving
 * appends; the DB path + session key alone cannot see a replacement whose
 * fresh rowids regrow past the cursor. ino 0 is "unpopulated" on some volumes
 * (network shares, FAT family) and would silently degrade to the path-keyed
 * form, so it is treated like a failed stat: reuse the last known identity,
 * else fall back to the path-keyed form.
 */
async function openCodeSourceFingerprint(dbPath: string, sessionId: string): Promise<string> {
  const fallback = `opencode:${dbPath}:${sessionId}`
  const cached = openCodeDbIdentity.get(dbPath)
  // One retry: a single transient stat failure (AV scan, sharing violation)
  // must not degrade the form at all. ino 0 is "unpopulated on this volume",
  // not a failure — retrying it cannot help.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stats = await wslGatedStat(dbPath, 'exact')
      if (Number.isFinite(stats.ino) && Number.isFinite(stats.dev) && stats.ino > 0) {
        const identity = { dev: stats.dev, ino: stats.ino }
        openCodeDbIdentity.set(dbPath, identity)
        return `${fallback}:${identity.dev}:${identity.ino}`
      }
      break
    } catch {
      if (attempt > 0) {
        break
      }
    }
  }
  return cached ? `${fallback}:${cached.dev}:${cached.ino}` : fallback
}
