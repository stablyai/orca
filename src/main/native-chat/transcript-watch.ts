// Live transcript tailing: watch a resolved session JSONL file and emit only
// the messages parsed from bytes appended since the last read. Modeled on the
// incremental byte-offset read in codex-usage/scanner.ts (parseCodexUsageFile's
// skipInitialBytes), but specialized to the NativeChatMessage record decoders.
//
// Teardown discipline (plan U4 risk: file-watch fd leaks): every subscription
// owns exactly one fs.FSWatcher and one debounce timer. unsubscribe() closes
// the watcher and clears the timer synchronously, and the module tracks the live
// watcher count so tests can assert no watcher survives teardown.

import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  /** Called with the newly-appended messages whenever the file grows. Never
   *  called with an empty array. */
  onAppend: (messages: NativeChatMessage[]) => void
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
  /** Coalesce window for rapid fs.watch events (ms). Defaults to 40ms. */
  debounceMs?: number
  /** Overrides the resolve-poll interval (see subscribeViaResolvePoll) so tests
   *  don't wait out the production backoff. Production ignores this and backs
   *  off from 500ms to a 5s cap. */
  resolvePollIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  /** Closes the watcher and releases the file handle. Idempotent. */
  unsubscribe: () => void
}

// Why: a single watch event can fire several times for one append; we read from
// the last byte offset so re-entrant reads never re-emit prior messages. Each
// decoder is stateless per-line, so tailing reuses the same record→message
// mapping the full reader uses.
const DEFAULT_DEBOUNCE_MS = 40

// Why: process-wide count of live FSWatchers opened by this module. The U4 leak
// test asserts this returns to zero after unsubscribe so a forgotten handle is
// caught deterministically rather than relying on OS fd inspection.
let activeWatcherCount = 0

/** Test-only: number of fs watchers this module currently holds open. */
export function getActiveNativeChatWatcherCount(): number {
  return activeWatcherCount
}

function lineDecoderForAgent(
  agent: AgentType
): ((line: string, fallbackId: string) => NativeChatMessage | null) | null {
  if (agent === 'claude') {
    return decodeClaudeTranscriptLine
  }
  if (agent === 'codex') {
    return decodeCodexTranscriptLine
  }
  if (agent === 'grok') {
    return decodeGrokTranscriptLine
  }
  return null
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * Read bytes [start, end) of the file and decode each complete line into a
 * NativeChatMessage. Opens its own fd and always closes it (no leak on the read
 * path, distinct from the long-lived watcher). Returns the messages plus the
 * byte offset actually consumed so a partially-written trailing line is re-read
 * on the next append rather than dropped.
 */
async function readAppendedMessages(
  filePath: string,
  start: number,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): Promise<{ messages: NativeChatMessage[]; consumedTo: number }> {
  const end = await fileSize(filePath)
  if (end <= start) {
    // File shrank (rotation/replacement) or unchanged — caller resets offset.
    return { messages: [], consumedTo: end }
  }

  const handle = await open(filePath, 'r')
  try {
    const stream = handle.createReadStream({
      encoding: 'utf-8',
      start,
      end: end - 1,
      autoClose: false
    })
    const { messages, consumedBytes } = await decodeTranscriptStream(
      stream,
      filePath,
      start,
      decode,
      false
    )
    return { messages, consumedTo: start + consumedBytes }
  } finally {
    await handle.close()
  }
}

/**
 * Install a live-tail watcher on an already-resolved file path. Returns null
 * (rather than throwing) when `watch()` fails — e.g. the file vanished between
 * resolve and install — so the caller can fall back to the resolve-poll below
 * instead of surfacing a hard error.
 */
function installTranscriptWatcher(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  onAppend: (messages: NativeChatMessage[]) => void,
  debounceMs?: number
): NativeChatTranscriptSubscription | null {
  // Why: seed the offset at 0 so the FIRST drain re-reads the whole file. This
  // closes the read/subscribe race — a turn appended between the caller's
  // readSession EOF and the watcher install is still emitted. Re-emitted lines
  // collapse by deterministic id in the assembler (no dup, no drop). Subsequent
  // drains use the incremental offset so the full re-read happens only once.
  let offset = 0
  let closed = false
  let reading = false
  let pendingReadRequested = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function drain(): Promise<void> {
    if (closed) {
      return
    }
    if (reading) {
      // A read is already in flight; mark that another pass is needed so rapid
      // successive appends coalesce without dropping the trailing one.
      pendingReadRequested = true
      return
    }
    reading = true
    try {
      do {
        pendingReadRequested = false
        try {
          const currentSize = await fileSize(filePath)
          if (currentSize < offset) {
            // Rotation/replacement/truncation: re-read from the top.
            offset = 0
          }
          const { messages, consumedTo } = await readAppendedMessages(filePath, offset, decode)
          offset = consumedTo
          if (!closed && messages.length > 0) {
            onAppend(messages)
          }
        } catch {
          // Why: a transient read failure (EACCES/EIO/ENOENT during rotation)
          // must not leave the subscription permanently deaf. Stop this drain;
          // the finally resets `reading` so a later fs event re-arms the read.
          break
        }
      } while (pendingReadRequested && !closed)
    } finally {
      reading = false
    }
  }

  function scheduleDrain(): void {
    if (closed) {
      return
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void drain()
    }, debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(filePath, scheduleDrain)
  } catch {
    // File vanished between resolve and watch.
    return null
  }
  activeWatcherCount++

  // Why: on some platforms fs.watch can miss the very first append that lands
  // between offset-seed and watcher install. Kick one debounced drain so a
  // turn written immediately after subscribe is still picked up.
  scheduleDrain()

  return {
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      watcher.close()
      activeWatcherCount--
    }
  }
}

/** One resolve+install attempt. Returns null when the file isn't resolvable
 *  yet, or vanished between resolve and `watch()` — either case is retried by
 *  the resolve-poll rather than treated as a hard failure. */
async function attemptInstall(
  args: SubscribeNativeChatTranscriptArgs,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): Promise<NativeChatTranscriptSubscription | null> {
  const filePath = args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args))
  if (!filePath) {
    return null
  }
  return installTranscriptWatcher(filePath, decode, args.onAppend, args.debounceMs)
}

// Why: Claude Code (and other agents) can take from ~3s to minutes to flush a
// brand-new session's first JSONL line (#8401) — resolveSessionFilePath
// genuinely has nothing to find yet. Poll for it instead of going deaf; each
// attempt is a cheap glob, so the cost of polling is negligible next to the
// gap it covers.
const INITIAL_RESOLVE_POLL_MS = 500
const MAX_RESOLVE_POLL_MS = 5_000

/**
 * Background retry loop for a transcript that hasn't been resolvable yet.
 * Returns a subscription immediately (per subscribeNativeChatTranscript's
 * contract); the loop keeps retrying resolve+install until it succeeds or
 * unsubscribe() cancels it.
 */
function subscribeViaResolvePoll(
  args: SubscribeNativeChatTranscriptArgs,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): NativeChatTranscriptSubscription {
  let closed = false
  let installed: NativeChatTranscriptSubscription | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let delay = args.resolvePollIntervalMs ?? INITIAL_RESOLVE_POLL_MS

  function scheduleAttempt(): void {
    if (closed) {
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      void runAttempt()
    }, delay)
    // Why: never hold the event loop open (headless `orca serve` shutdown) for
    // a session that may genuinely never resolve.
    pollTimer.unref?.()
    // Only back off in production; a test-supplied interval stays fixed so
    // tests resolve in bounded, predictable time.
    if (args.resolvePollIntervalMs === undefined) {
      delay = Math.min(delay * 2, MAX_RESOLVE_POLL_MS)
    }
  }

  async function runAttempt(): Promise<void> {
    if (closed) {
      return
    }
    let result: NativeChatTranscriptSubscription | null
    try {
      result = await attemptInstall(args, decode)
    } catch {
      // Why: a transient resolve failure (EACCES/EIO during the glob) must not
      // kill the poll loop with an unhandled rejection — retry like a miss.
      result = null
    }
    if (closed) {
      // unsubscribe() ran while this attempt was in flight.
      result?.unsubscribe()
      return
    }
    if (result) {
      installed = result
      return
    }
    scheduleAttempt()
  }

  scheduleAttempt()

  return {
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      installed?.unsubscribe()
      installed = null
    }
  }
}

/**
 * Subscribe to live appends on an agent's transcript file. Returns an
 * unsubscribe fn that tears the watcher down completely.
 *
 * Handles file rotation/replacement: when the file shrinks (a new session id
 * resolved to a smaller/newer file, or the file was truncated), the offset is
 * reset to 0 so the replacement's content is read from the top.
 *
 * When the transcript isn't resolvable yet (a just-created session whose
 * agent hasn't flushed its first JSONL line, #8401), returns the subscription
 * immediately and keeps retrying resolve+install in the background rather
 * than returning a no-op that never recovers.
 */
export async function subscribeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs
): Promise<NativeChatTranscriptSubscription> {
  const decode = lineDecoderForAgent(args.agent)
  if (!decode) {
    // Nothing watchable — return a no-op teardown so callers can unconditionally
    // unsubscribe without null-checks.
    return { unsubscribe: () => {} }
  }
  // Why: a blank session id (and no explicit file) can never resolve — bail out
  // instead of resolve-polling an unresolvable target forever.
  if (!args.filePath && !args.sessionId.trim()) {
    return { unsubscribe: () => {} }
  }

  const installed = await attemptInstall(args, decode)
  if (installed) {
    return installed
  }
  return subscribeViaResolvePoll(args, decode)
}
