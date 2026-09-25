import { errorMessage } from '../ai-vault/session-scanner-values'
import {
  DESKTOP_READ_WINDOW,
  UNFLUSHED_SETTLE_MS,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import type { OpenCodeTranscriptItem } from './transcript-opencode-sqlite-query'
import { openCodeTranscriptDefaultDeps, type OpenCodeTranscriptDeps } from './transcript-opencode'

// Why: live subscription split from the read adapters (transcript-opencode.ts)
// so each module stays under the repo's file-size cap.

/** How often the live watcher polls the cheap change signal. */
const OPENCODE_POLL_MS = 1_000
/** Page size the watcher diffs against, covering tool-result backfill depth. */
const WATCH_DIFF_WINDOW = 100
/** Widest replacement window when bridging a poll-gap burst; beyond it the gap
 *  holds back and retries instead of dropping rows. Also caps the fingerprint
 *  cache: no later window can reference older entries. */
const WATCH_REPLACE_MAX_WINDOW = 2400

/** Keeps only the newest `cap` fingerprints: every future window read is
 *  bounded by WATCH_REPLACE_MAX_WINDOW items, so older entries are unreachable
 *  and the cache cannot grow with the session for the subscription's life. */
function pruneOpenCodeFingerprintCache(fingerprints: Map<number, string>, cap: number): void {
  if (fingerprints.size <= cap) {
    return
  }
  const keep = new Set([...fingerprints.keys()].sort((a, b) => b - a).slice(0, cap))
  for (const rowid of fingerprints.keys()) {
    if (!keep.has(rowid)) {
      fingerprints.delete(rowid)
    }
  }
}

export const pruneOpenCodeFingerprintCacheForTest = pruneOpenCodeFingerprintCache

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
  setupSignal?.throwIfAborted()
  const resolveDbPath = deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath
  const readSignal = deps.readSignal ?? openCodeTranscriptDefaultDeps.readSignal
  const readPage = deps.readPage ?? openCodeTranscriptDefaultDeps.readPage
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
  // Whether the subscriber already has a frame (or pending notice) to render.
  let settled = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  const onAbort = () => unsubscribe()
  setupSignal?.addEventListener('abort', onAbort, { once: true })

  function stopSettleTimer(): void {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  /** Report a still-pending transcript once so the view can leave 'loading'
   *  and invite a first message instead of spinning (#8401 — same settle as
   *  subscribeViaResolvePoll). Deliberately not a snapshot: an empty window
   *  presented as a settled read would capture over retained history. */
  function settleUnflushed(): void {
    settleTimer = null
    if (closed || settled || !args.onTranscriptPending) {
      return
    }
    settled = true
    emitSafely(() => args.onTranscriptPending?.(), 'pending')
  }

  if (args.onTranscriptPending) {
    settleTimer = setTimeout(settleUnflushed, UNFLUSHED_SETTLE_MS)
    settleTimer.unref?.()
  }

  // Why: subscriber callbacks belong to the renderer/host — a bug there must
  // never break the poll loop (an escaping throw would skip scheduleTick and
  // leave polling permanently deaf on a void tick()).
  function emitSafely(run: () => void, what: string): void {
    try {
      run()
    } catch (err) {
      console.warn(
        `OpenCode native-chat subscriber (${what}) threw; polling continues. ${errorMessage(err)}`
      )
    }
  }

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
      if (closed) {
        return
      }
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
      if (firstSnapshot) {
        lastSignal = fingerprint
        rememberItems(page.items)
        settled = true
        stopSettleTimer()
        const snapshot = page.items.map((item) => item.message)
        const snapshotHasMore = page.hasMore
        const snapshotBefore = page.beforeMessageRowId ?? 0
        emitSafely(
          () => args.onInitialSnapshot?.(snapshot, snapshotHasMore, snapshotBefore),
          'snapshot'
        )
        scheduleTick()
        return
      }
      const changed = page.items.some(
        (item) =>
          item.rowid <= lastEmittedRowId &&
          fingerprints.has(item.rowid) &&
          fingerprints.get(item.rowid) !== item.fingerprint
      )
      if (changed) {
        // Why: an already-rendered message went stale (tool-result backfill).
        if (await replaceWithBridgedWindow(dbPath)) {
          lastSignal = fingerprint
        }
        scheduleTick()
        return
      }
      const appended = page.items.filter((item) => item.rowid > lastEmittedRowId)
      // Why: zero overlap = window overflow; advancing would drop rows — re-read wider.
      if (appended.length > 0 && appended.length === page.items.length && page.hasMore) {
        if (await replaceWithBridgedWindow(dbPath)) {
          lastSignal = fingerprint
        }
        scheduleTick()
        return
      }
      if (appended.length > 0) {
        rememberItems(appended)
        const appendedMessages = appended.map((item) => item.message)
        emitSafely(() => args.onAppend(appendedMessages), 'append')
      }
      lastSignal = fingerprint
      scheduleTick()
    } catch (err) {
      // Why: a transient worker failure must not kill the poll loop; surface
      // it once while no snapshot has been delivered, then keep polling — a
      // later tick's real snapshot still replaces the error frame.
      if (!closed && lastSignal === null && !gateErrorEmitted && args.onInitialSnapshot) {
        gateErrorEmitted = true
        // Its retryable message outranks the empty settle; don't overwrite it.
        settled = true
        stopSettleTimer()
        const failure = errorMessage(err)
        emitSafely(() => args.onInitialSnapshot?.([], false, 0, failure), 'error')
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
    pruneOpenCodeFingerprintCache(fingerprints, WATCH_REPLACE_MAX_WINDOW)
  }

  // Bounded reads on the worker thread shared with the AI-Vault scanner.
  // Widens until the window overlaps the emitted frontier: a poll-gap burst
  // bigger than one window must bridge, not skip. Holds everything back (no
  // lastSignal/lastEmittedRowId advance) when even the capped window cannot
  // overlap, so the gap retries instead of dropping rows.
  async function replaceWithBridgedWindow(db: string): Promise<boolean> {
    let limit = initialLimit
    for (;;) {
      const replacement = await readPage({
        dbPath: db,
        sessionId: args.sessionId,
        limit
      })
      if (closed || !replacement) {
        return false
      }
      const oldest = replacement.items[0]?.rowid
      if (oldest === undefined) {
        // Empty renderable window (only non-renderable rows moved the
        // signal): nothing to bridge — settle like a normal replace.
        const hasMore = replacement.hasMore
        const before = replacement.beforeMessageRowId ?? 0
        emitSafely(() => args.onReplace?.([], hasMore, before), 'replace')
        return true
      }
      if (oldest <= lastEmittedRowId) {
        rememberItems(replacement.items)
        const messages = replacement.items.map((item) => item.message)
        const hasMore = replacement.hasMore
        const before = replacement.beforeMessageRowId ?? 0
        emitSafely(() => args.onReplace?.(messages, hasMore, before), 'replace')
        return true
      }
      if (limit >= WATCH_REPLACE_MAX_WINDOW) {
        return false
      }
      limit = Math.min(limit * 2, WATCH_REPLACE_MAX_WINDOW)
    }
  }

  function unsubscribe(): void {
    if (closed) {
      return
    }
    closed = true
    setupSignal?.removeEventListener('abort', onAbort)
    stopSettleTimer()
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  void tick()
  return { unsubscribe, watching: true }
}
