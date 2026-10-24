import { pruneOpenCodeFingerprintCache } from './transcript-opencode-fingerprint-window'
export { pruneOpenCodeFingerprintCache as pruneOpenCodeFingerprintCacheForTest } from './transcript-opencode-fingerprint-window'
import { errorMessage } from '../ai-vault/session-scanner-values'
import {
  DESKTOP_READ_WINDOW,
  UNFLUSHED_SETTLE_MS,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import type { OpenCodeTranscriptItem } from './transcript-opencode-sqlite-query'
import { openCodeTranscriptDefaultDeps, type OpenCodeTranscriptDeps } from './transcript-opencode'
import {
  openCodeTranscriptPageLimit,
  OPENCODE_TRANSCRIPT_MAX_WINDOW
} from '../../shared/opencode-transcript-page-limit'

const OPENCODE_POLL_MS = 1_000

export function subscribeOpenCodeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal,
  deps: OpenCodeTranscriptDeps = {},
  agent?: 'zcode'
): NativeChatTranscriptSubscription {
  setupSignal?.throwIfAborted()
  const controller = new AbortController()
  const resolveDbPath = deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath
  const readSignal = deps.readSignal ?? openCodeTranscriptDefaultDeps.readSignal
  const readPage = (page: Parameters<NonNullable<OpenCodeTranscriptDeps['readPage']>>[0]) =>
    (deps.readPage ?? openCodeTranscriptDefaultDeps.readPage)(
      { ...page, ...(agent ? { agent } : {}) },
      controller.signal
    )
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
  // Escaping subscriber errors would skip scheduling and permanently stop polling.
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
      dbPath ??= await resolveDbPath(args.sessionId, controller.signal, agent)
      if (closed) {
        return
      }
      if (!dbPath) {
        scheduleTick()
        return
      }
      const signal = await readSignal(dbPath, args.sessionId, controller.signal, agent)
      if (closed) {
        return
      }
      if (!signal) {
        // Hooks may arrive before the session row.
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
      // Imported ZCode rows may precede the frontier regardless of storage rowid.
      if (agent === 'zcode') {
        if (
          await replaceWithBridgedWindow(dbPath, page, signal.messageCount < lastCounts.messages)
        ) {
          lastSignal = fingerprint
          lastCounts = { messages: signal.messageCount, parts: signal.partCount }
        }
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
          // Check displaced rows: tail eviction and deletion otherwise look identical.
          const older = await readPage({
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
      // Balanced delete/append can hide a removed row before the new tail.
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
        // Keep retryable errors visible instead of overwriting with empty settlement.
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
    pruneOpenCodeFingerprintCache(fingerprints, OPENCODE_TRANSCRIPT_MAX_WINDOW, agent)
    windowLimit = Math.max(windowLimit, fingerprints.size)
  }

  // Widen bounded worker reads until they overlap the emitted frontier, bridging poll-gap bursts.
  // If even the cap cannot overlap, retain the old signal/frontier and retry without losing rows.
  async function replaceWithBridgedWindow(
    db: string,
    page: Awaited<ReturnType<typeof readPage>>,
    shrinking = false
  ): Promise<boolean> {
    let limit = Math.max(windowLimit, page?.items.length ?? 0)
    for (;;) {
      const replacement =
        page ??
        (await readPage({
          dbPath: db,
          sessionId: args.sessionId,
          limit
        }))
      if (closed || !replacement) {
        return false
      }
      const oldest = replacement.items[0]?.rowid
      if (oldest === undefined) {
        // Non-renderable-only changes leave nothing to bridge.
        const hasMore = replacement.hasMore
        const before = replacement.beforeMessageRowId ?? 0
        fingerprints.clear()
        lastEmittedRowId = 0
        emitSafely(() => args.onReplace?.([], hasMore, before), 'replace')
        return true
      }
      const overlaps =
        agent === 'zcode'
          ? replacement.items.some((item) => fingerprints.has(item.rowid))
          : oldest <= lastEmittedRowId
      if (shrinking || overlaps || !replacement.hasMore) {
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
