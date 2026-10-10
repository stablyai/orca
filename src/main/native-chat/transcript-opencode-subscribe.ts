import { errorMessage } from '../ai-vault/session-scanner-values'
import {
  DESKTOP_READ_WINDOW,
  UNFLUSHED_SETTLE_MS,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import type { OpenCodeTranscriptItem } from './transcript-opencode-sqlite-query'
import { bindOpenCodeTranscriptDeps, type OpenCodeTranscriptDeps } from './transcript-opencode'
import {
  openCodeTranscriptPageLimit,
  OPENCODE_TRANSCRIPT_MAX_WINDOW
} from '../../shared/opencode-transcript-page-limit'

const OPENCODE_POLL_MS = 1_000

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

export function subscribeOpenCodeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal,
  deps: OpenCodeTranscriptDeps = {},
  // When 'zcode': discovery probes ZCode's database, reads drop hidden rows.
  agent?: 'zcode'
): NativeChatTranscriptSubscription {
  setupSignal?.throwIfAborted()
  const controller = new AbortController()
  const bound = bindOpenCodeTranscriptDeps(deps, controller.signal, agent)
  const pollMs = args.resolvePollIntervalMs ?? OPENCODE_POLL_MS
  const initialLimit = openCodeTranscriptPageLimit(
    args.initialLimit && args.initialLimit > 0 ? args.initialLimit : DESKTOP_READ_WINDOW
  )

  let closed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let dbPath: string | null = null
  let lastSignal: string | null = null
  let lastEmittedRowId = 0
  let lastCounts = { messages: 0, parts: 0 }
  let windowLimit = initialLimit
  const fingerprints = new Map<number, string>()
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
    pollTimer.unref?.()
  }

  async function tick(): Promise<void> {
    if (closed) {
      return
    }
    try {
      dbPath ??= await bound.resolveDbPath()
      if (closed) {
        return
      }
      if (!dbPath) {
        // No DB (yet): keep polling, like the JSONL resolve-poll path (#8401).
        scheduleTick()
        return
      }
      const signal = await bound.readSignal(dbPath, args.sessionId)
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
      const page = await bound.readPage({
        dbPath,
        sessionId: args.sessionId,
        limit: firstSnapshot
          ? initialLimit
          : Math.min(
              OPENCODE_TRANSCRIPT_MAX_WINDOW,
              windowLimit + Math.max(0, signal.messageCount - lastCounts.messages)
            )
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
        lastCounts = { messages: signal.messageCount, parts: signal.partCount }
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
      let changed = page.items.some(
        (item) =>
          item.rowid <= lastEmittedRowId && fingerprints.get(item.rowid) !== item.fingerprint
      )
      const shrinking =
        signal.messageCount < lastCounts.messages || signal.partCount < lastCounts.parts
      const present = new Set(page.items.map((item) => item.rowid))
      if (
        !changed &&
        !shrinking &&
        page.hasMore &&
        fingerprints.size === OPENCODE_TRANSCRIPT_MAX_WINDOW &&
        page.items.length === OPENCODE_TRANSCRIPT_MAX_WINDOW
      ) {
        const oldest = page.items[0]!.rowid
        const displaced = [...fingerprints.keys()].filter((rowid) => rowid < oldest)
        if (displaced.length > 0) {
          // Verify the displaced fringe: cap eviction and a real deletion look identical in the tail.
          const older = await bound.readPage({
            dbPath,
            sessionId: args.sessionId,
            limit: displaced.length,
            beforeMessageRowId: oldest
          })
          if (closed || !older) {
            scheduleTick()
            return
          }
          for (const item of older.items) {
            present.add(item.rowid)
            changed ||= fingerprints.get(item.rowid) !== item.fingerprint
          }
        }
      }
      // A balanced delete and append can move a removed row before the new tail.
      const removed = [...fingerprints.keys()].some((rowid) => !present.has(rowid))
      if (changed || shrinking || removed) {
        if (await replaceWithBridgedWindow(dbPath, page, shrinking)) {
          lastSignal = fingerprint
          lastCounts = { messages: signal.messageCount, parts: signal.partCount }
        }
        scheduleTick()
        return
      }
      const appended = page.items.filter((item) => item.rowid > lastEmittedRowId)
      if (appended.length > 0 && appended.length === page.items.length && page.hasMore) {
        if (await replaceWithBridgedWindow(dbPath, page)) {
          lastSignal = fingerprint
          lastCounts = { messages: signal.messageCount, parts: signal.partCount }
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
      lastCounts = { messages: signal.messageCount, parts: signal.partCount }
      scheduleTick()
    } catch (err) {
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
    pruneOpenCodeFingerprintCache(fingerprints, OPENCODE_TRANSCRIPT_MAX_WINDOW)
    windowLimit = Math.max(windowLimit, fingerprints.size)
  }

  // Bounded reads on the worker thread shared with the AI-Vault scanner.
  // Widens until the window overlaps the emitted frontier: a poll-gap burst
  // bigger than one window must bridge, not skip. Holds everything back (no
  // lastSignal/lastEmittedRowId advance) when even the capped window cannot
  // overlap, so the gap retries instead of dropping rows.
  async function replaceWithBridgedWindow(
    db: string,
    page: Awaited<ReturnType<typeof bound.readPage>>,
    shrinking = false
  ): Promise<boolean> {
    let limit = Math.max(windowLimit, page?.items.length ?? 0)
    for (;;) {
      const replacement =
        page ??
        (await bound.readPage({
          dbPath: db,
          sessionId: args.sessionId,
          limit
        }))
      if (closed || !replacement) {
        return false
      }
      const oldest = replacement.items[0]?.rowid
      if (oldest === undefined) {
        // Empty renderable window (only non-renderable rows moved the
        // signal): nothing to bridge — settle like a normal replace.
        const hasMore = replacement.hasMore
        const before = replacement.beforeMessageRowId ?? 0
        fingerprints.clear()
        lastEmittedRowId = 0
        emitSafely(() => args.onReplace?.([], hasMore, before), 'replace')
        return true
      }
      if (shrinking || oldest <= lastEmittedRowId || !replacement.hasMore) {
        fingerprints.clear()
        lastEmittedRowId = 0
        rememberItems(replacement.items)
        const messages = replacement.items.map((item) => item.message)
        const hasMore = replacement.hasMore
        const before = replacement.beforeMessageRowId ?? 0
        emitSafely(() => args.onReplace?.(messages, hasMore, before), 'replace')
        return true
      }
      if (limit >= OPENCODE_TRANSCRIPT_MAX_WINDOW) {
        return false
      }
      limit = Math.min(limit * 2, OPENCODE_TRANSCRIPT_MAX_WINDOW)
      page = null
    }
  }

  function unsubscribe(): void {
    if (closed) {
      return
    }
    closed = true
    controller.abort()
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
