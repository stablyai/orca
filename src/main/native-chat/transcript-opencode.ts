import { basename } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import type { ReadTranscriptResult } from './transcript-reader'
import {
  readOpenCodeTranscriptPageViaWorker,
  readOpenCodeTranscriptSignalViaWorker
} from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { listOpenCodeDatabases } from '../opencode-usage/scanner'
import type {
  OpenCodeTranscriptItem,
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import {
  DESKTOP_READ_WINDOW,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

// Why: OpenCode keeps its transcript in a SQLite DB (opencode.db) under the
// XDG data home, not a per-session JSONL file. This module resolves that DB
// and adapts the worker-backed page/signal reads onto the native-chat
// read/tail/subscribe contracts the IPC and RPC handlers already route
// through. All SQLite I/O stays on the shared OpenCode worker thread.

/** How often the live watcher polls the cheap change signal. */
const OPENCODE_POLL_MS = 1_000
/** Page size the watcher diffs against, covering tool-result backfill depth. */
const WATCH_DIFF_WINDOW = 100

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
  const dbPaths = await listOpenCodeDatabases()
  // The canonical opencode.db is the live database; stale opencode-*.db
  // siblings are backups (same ranking as the scanner's claim priority).
  return (
    dbPaths.find((dbPath) => basename(dbPath).toLowerCase() === 'opencode.db') ?? dbPaths[0] ?? null
  )
}

/**
 * Resolve the OpenCode transcript DB, or null when it does not exist yet.
 * Exported so non-native-chat consumers (the orchestration worker transcript
 * read) share the same discovery instead of re-deriving the data directory.
 */
export function resolveOpenCodeTranscriptDbPath(): Promise<string | null> {
  return defaultResolveDbPath()
}

const defaultDeps: Required<OpenCodeTranscriptDeps> = {
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
  const dbPath = await (deps.resolveDbPath ?? defaultDeps.resolveDbPath)()
  if (!dbPath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  let page: OpenCodeTranscriptPage | null
  try {
    page = await (deps.readPage ?? defaultDeps.readPage)({
      dbPath,
      sessionId: args.sessionId,
      limit,
      ...(args.beforeOffset !== undefined ? { beforeMessageRowId: args.beforeOffset } : {})
    })
  } catch (err) {
    return { error: errorMessage(err) }
  }
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
  const dbPath = await (deps.resolveDbPath ?? defaultDeps.resolveDbPath)()
  if (!dbPath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  const readPage = deps.readPage ?? defaultDeps.readPage
  // Each page is oldest-first, but paging walks newest window to oldest —
  // collect then reverse so the concatenated result is globally oldest-first.
  const pages: NativeChatMessage[][] = []
  let cursor: number | undefined
  try {
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
      if (!page.hasMore || page.beforeMessageRowId == null) {
        break
      }
      cursor = page.beforeMessageRowId
    }
  } catch (err) {
    return { error: errorMessage(err) }
  }
  return { messages: pages.toReversed().flat() }
}

/**
 * Live OpenCode transcript subscription: polls the cheap change signal and,
 * only when it moved, re-reads a bounded window to diff new/changed messages.
 * Emits `onAppend` for new messages and `onReplace` when an already-emitted
 * message changed in place (a tool result landing on an existing part row).
 */
export function subscribeOpenCodeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal,
  deps: OpenCodeTranscriptDeps = {}
): NativeChatTranscriptSubscription {
  const resolveDbPath = deps.resolveDbPath ?? defaultDeps.resolveDbPath
  const readSignal = deps.readSignal ?? defaultDeps.readSignal
  const readPage = deps.readPage ?? defaultDeps.readPage
  const pollMs = args.resolvePollIntervalMs ?? OPENCODE_POLL_MS
  const initialLimit =
    args.initialLimit && args.initialLimit > 0 ? args.initialLimit : DESKTOP_READ_WINDOW

  let closed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let dbPath: string | null = null
  let lastSignal: string | null = null
  let lastEmittedRowId = 0
  const fingerprints = new Map<number, string>()
  // Why: latch the first error frame so a persistently failing read (worker
  // crash loop) cannot re-emit it every poll tick — mirrors the engine's
  // initialErrorEmitted guard in transcript-watch-engine.ts.
  let gateErrorEmitted = false

  const onAbort = () => unsubscribe()
  setupSignal?.addEventListener('abort', onAbort, { once: true })

  function scheduleTick(): void {
    if (closed) {
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      void tick()
    }, pollMs)
    // Why: never hold the event loop open (headless `orca serve` shutdown).
    pollTimer.unref?.()
  }

  async function tick(): Promise<void> {
    if (closed) {
      return
    }
    try {
      dbPath ??= await resolveDbPath()
      if (!dbPath) {
        // No DB (yet): keep polling, like the JSONL resolve-poll path (#8401).
        scheduleTick()
        return
      }
      const signal = await readSignal(dbPath, args.sessionId)
      if (closed) {
        return
      }
      if (!signal) {
        // Session row not landed yet — the hook can fire first.
        scheduleTick()
        return
      }
      const fingerprint = `${signal.messageCount}:${signal.partCount}:${signal.maxMessageRowId}:${signal.maxPartTimeUpdated}`
      const firstSnapshot = lastSignal === null
      if (!firstSnapshot && fingerprint === lastSignal) {
        scheduleTick()
        return
      }
      const page = await readPage({
        dbPath,
        sessionId: args.sessionId,
        limit: firstSnapshot ? initialLimit : WATCH_DIFF_WINDOW
      })
      if (closed) {
        return
      }
      if (!page) {
        // The session vanished between signal and page reads; keep polling.
        scheduleTick()
        return
      }
      // Why: latch only after the read succeeds — a latched-but-failed first
      // read would stall forever on the unchanged fingerprint.
      lastSignal = fingerprint
      if (firstSnapshot) {
        rememberItems(page.items)
        args.onInitialSnapshot?.(
          page.items.map((item) => item.message),
          page.hasMore,
          page.beforeMessageRowId ?? 0
        )
        scheduleTick()
        return
      }
      const changed = page.items.some(
        (item) =>
          item.rowid <= lastEmittedRowId && fingerprints.get(item.rowid) !== item.fingerprint
      )
      if (changed) {
        // Why: an already-rendered message went stale (tool-result backfill).
        await replaceWithInitialWindow(dbPath)
        scheduleTick()
        return
      }
      const appended = page.items.filter((item) => item.rowid > lastEmittedRowId)
      // Why: zero overlap = window overflow; advancing would drop rows — re-read wider.
      if (appended.length > 0 && appended.length === page.items.length && page.hasMore) {
        await replaceWithInitialWindow(dbPath)
        scheduleTick()
        return
      }
      if (appended.length > 0) {
        rememberItems(appended)
        args.onAppend(appended.map((item) => item.message))
      }
      scheduleTick()
    } catch (err) {
      // Why: a transient worker failure must not kill the poll loop; surface
      // it once while no snapshot has been delivered, then keep polling — a
      // later tick's real snapshot still replaces the error frame.
      if (lastSignal === null && !gateErrorEmitted && args.onInitialSnapshot) {
        gateErrorEmitted = true
        args.onInitialSnapshot?.([], false, 0, errorMessage(err))
      }
      scheduleTick()
    }
  }

  function rememberItems(items: OpenCodeTranscriptItem[]): void {
    for (const item of items) {
      fingerprints.set(item.rowid, item.fingerprint)
      if (item.rowid > lastEmittedRowId) {
        lastEmittedRowId = item.rowid
      }
    }
  }

  // Bounded reads on the worker thread shared with the AI-Vault scanner.
  async function replaceWithInitialWindow(db: string): Promise<void> {
    const replacement = await readPage({
      dbPath: db,
      sessionId: args.sessionId,
      limit: initialLimit
    })
    if (closed) {
      return
    }
    if (replacement) {
      rememberItems(replacement.items)
      args.onReplace?.(
        replacement.items.map((item) => item.message),
        replacement.hasMore,
        replacement.beforeMessageRowId ?? 0
      )
    }
  }

  function unsubscribe(): void {
    if (closed) {
      return
    }
    closed = true
    setupSignal?.removeEventListener('abort', onAbort)
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  void tick()
  return { unsubscribe, watching: true }
}
