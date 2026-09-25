import { basename } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import type { ReadTranscriptResult } from './transcript-reader'
import {
  readOpenCodeTranscriptPageViaWorker,
  readOpenCodeTranscriptSignalViaWorker
} from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { listOpenCodeDatabases } from '../opencode-usage/opencode-database-discovery'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import type {
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import { DESKTOP_READ_WINDOW } from './transcript-watch-contract'

// Why: OpenCode keeps its transcript in a SQLite DB (opencode.db) under the
// XDG data home, not a per-session JSONL file. This module resolves that DB
// and adapts the worker-backed page/signal reads onto the native-chat
// read/tail contracts the IPC and RPC handlers already route through. All
// SQLite I/O stays on the shared OpenCode worker thread. The live
// subscription lives in transcript-opencode-subscribe.ts (file-size cap).
// WSL-guest sessions are gated off in the renderer (native-chat-availability):
// the DB resolves on the desktop host only — parity with the orchestration
// reader's WSL refusal.

export type OpenCodeTranscriptDeps = {
  resolveDbPath?: () => Promise<string | null>
  readSignal?: (dbPath: string, sessionId: string) => Promise<OpenCodeTranscriptSignal | null>
  readPage?: (args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeMessageRowId?: number
  }) => Promise<OpenCodeTranscriptPage | null>
}

async function defaultResolveDbPath(): Promise<string | null> {
  // Why: reuse the canonical discovery (OPENCODE_DB override, opencode-*.db
  // siblings, WSL-gated data dirs) so native chat sees every DB the AI-Vault
  // scanner sees, instead of a narrower re-derivation of the data directory.
  // v2 DBs are excluded via the shared name predicate: their session_v2
  // schema would only hard-fail the v1 queries, so a machine with only
  // OpenCode 2 reports no DB (not-found), not an error.
  const dbPaths = await listOpenCodeDatabases()
  const v1DbPaths = dbPaths.filter((dbPath) => !isOpenCodeV2DatabaseName(basename(dbPath)))
  // The canonical opencode.db is the live database; stale opencode-*.db
  // siblings are backups (same ranking as the scanner's claim priority).
  return (
    v1DbPaths.find((dbPath) => basename(dbPath).toLowerCase() === 'opencode.db') ??
    v1DbPaths[0] ??
    null
  )
}

/**
 * Resolve the OpenCode transcript DB, or null when it does not exist yet.
 * Public discovery API: consumed directly by tests and the worker-output
 * isolation mock; production readers share the same discovery through
 * `openCodeTranscriptDefaultDeps.resolveDbPath`.
 */
export function resolveOpenCodeTranscriptDbPath(): Promise<string | null> {
  return defaultResolveDbPath()
}

export const openCodeTranscriptDefaultDeps: Required<OpenCodeTranscriptDeps> = {
  resolveDbPath: defaultResolveDbPath,
  readSignal: (dbPath, sessionId) => readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId }),
  readPage: (args) => readOpenCodeTranscriptPageViaWorker(args)
}

export type OpenCodeTailResult =
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }

/**
 * Read the newest `limit` renderable messages of an OpenCode session.
 * `beforeOffset` is the opaque `message` rowid cursor handed back by a
 * previous page (the renderer never interprets it).
 */
export async function readOpenCodeNativeChatTranscriptTail(
  args: { sessionId: string; limit: number; beforeOffset?: number },
  deps: OpenCodeTranscriptDeps = {}
): Promise<OpenCodeTailResult> {
  const limit = args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  // Why: DB discovery scans the filesystem and can throw (EACCES/EIO) — the
  // value-error contract callers rely on must not leak a rejection, so it
  // lives inside the same try as the page read.
  try {
    const dbPath = await (deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath)()
    if (!dbPath) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const page = await (deps.readPage ?? openCodeTranscriptDefaultDeps.readPage)({
      dbPath,
      sessionId: args.sessionId,
      limit,
      ...(args.beforeOffset !== undefined ? { beforeMessageRowId: args.beforeOffset } : {})
    })
    if (!page) {
      // Why: a brand-new session can report its id before the DB row lands;
      // callers keep that miss in loading/retry rather than a hard error (#8401).
      return { error: 'Transcript unavailable', notFound: true }
    }
    return {
      messages: page.items.map((item) => item.message),
      hasMore: page.hasMore,
      beforeOffset: page.beforeMessageRowId ?? 0
    }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

/**
 * Read the ENTIRE OpenCode session transcript, no message cap, oldest-first —
 * mirroring the JSONL full reader. Pages through the DB in bounded chunks so
 * one worker request never carries a whole multi-thousand-message session.
 */
export async function readOpenCodeNativeChatTranscriptFull(
  sessionId: string,
  deps: OpenCodeTranscriptDeps = {}
): Promise<ReadTranscriptResult> {
  // Discovery lives inside the try for the same value-error contract as the
  // tail read — a throwing filesystem scan must return {error}, not reject.
  // Each page is oldest-first, but paging walks newest window to oldest —
  // collect then reverse so the concatenated result is globally oldest-first.
  const pages: NativeChatMessage[][] = []
  let cursor: number | undefined
  try {
    const dbPath = await (deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath)()
    if (!dbPath) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const readPage = deps.readPage ?? openCodeTranscriptDefaultDeps.readPage
    for (;;) {
      const page = await readPage({
        dbPath,
        sessionId,
        limit: 500,
        ...(cursor !== undefined ? { beforeMessageRowId: cursor } : {})
      })
      if (!page) {
        if (cursor === undefined) {
          return { error: 'Transcript unavailable', notFound: true }
        }
        break
      }
      pages.push(page.items.map((item) => item.message))
      if (!page.hasMore || page.beforeMessageRowId == null || page.beforeMessageRowId === cursor) {
        break
      }
      cursor = page.beforeMessageRowId
    }
  } catch (err) {
    return { error: errorMessage(err) }
  }
  return { messages: pages.toReversed().flat() }
}
