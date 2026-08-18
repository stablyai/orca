import { extname } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  needsWslHostTranslation,
  toHostReadableTranscriptPath
} from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'
import { installTranscriptWatcher } from './transcript-watch-engine'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import { WslTranscriptFsError, wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

export { readNativeChatTranscriptTail } from './transcript-tail-reader'
export { getActiveNativeChatWatcherCount } from './transcript-watch-engine'
export type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

/** One resolve+install attempt. Returns null while the transcript file itself
 *  is unresolved; native-watch failure degrades to reconciliation-only mode. */
async function attemptInstall(
  args: SubscribeNativeChatTranscriptArgs,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  signal?: AbortSignal
): Promise<NativeChatTranscriptSubscription | null> {
  const filePath =
    args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args, signal))
  signal?.throwIfAborted()
  if (!filePath) {
    return null
  }
  const installed = await installTranscriptWatcher(filePath, decode, args, signal)
  if (signal?.aborted) {
    installed?.unsubscribe()
    signal.throwIfAborted()
  }
  return installed
}

// Why: Claude Code (and other agents) can take from ~3s to minutes to flush a
// brand-new session's first JSONL line (#8401) — resolveSessionFilePath
// genuinely has nothing to find yet. Poll for it instead of going deaf. Exact
// hook paths are probed on every retry; the recursive
// session-id fallback runs less often because a large Claude tree is expensive.
const INITIAL_RESOLVE_POLL_MS = 500
const MAX_RESOLVE_POLL_MS = 5_000
const FALLBACK_RESOLVE_POLL_MS = 5_000

function exactTranscriptPath(args: SubscribeNativeChatTranscriptArgs): string | null {
  const path = args.transcriptPath?.trim()
  return path && extname(path) === '.jsonl' ? path : null
}

/**
 * Background retry loop for a transcript that hasn't been resolvable yet.
 * Returns a subscription immediately (per subscribeNativeChatTranscript's
 * contract); the loop keeps retrying resolve+install until it succeeds or
 * unsubscribe() cancels it. Reports watching:true — the engine's first drain
 * delivers the initial snapshot once the file appears, so subscribers must not
 * settle a merely not-yet-flushed transcript into a permanent error (#8401).
 */
function subscribeViaResolvePoll(
  args: SubscribeNativeChatTranscriptArgs,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): NativeChatTranscriptSubscription {
  let closed = false
  let installed: NativeChatTranscriptSubscription | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let delay = args.resolvePollIntervalMs ?? INITIAL_RESOLVE_POLL_MS
  let lastFallbackResolveAt = Date.now()
  const exactPath = exactTranscriptPath(args)
  // Why: WSL hooks report guest Linux paths the Windows host cannot open; the
  // UNC twin is resolved lazily (the distro may still be cold) and memoized so
  // the exact-path install doesn't wait on the slower id-glob (#10326).
  let hostReadableExactPath: string | null = null
  let lastWslTranslateAt = 0
  // Latches only once a frame was actually emitted, so a subscriber without the
  // callback can't suppress it for a later one.
  let gateErrorEmitted = false
  const resolveController = new AbortController()

  function scheduleAttempt(): void {
    if (closed) {
      return
    }
    const untilFallbackResolve = exactPath
      ? Math.max(0, FALLBACK_RESOLVE_POLL_MS - (Date.now() - lastFallbackResolveAt))
      : delay
    pollTimer = setTimeout(
      () => {
        pollTimer = null
        void runAttempt()
      },
      Math.min(delay, untilFallbackResolve)
    )
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
      if (exactPath && !hostReadableExactPath) {
        if (!needsWslHostTranslation(exactPath)) {
          // Non-WSL paths stay raw: installTranscriptWatcher already handles a
          // not-yet-created file, so don't spend an extra probe per tick.
          hostReadableExactPath = exactPath
        } else if (Date.now() - lastWslTranslateAt >= FALLBACK_RESOLVE_POLL_MS) {
          // Why: translating probes the UNC twin per distro over the 9P
          // share, and the guest file usually appears well after the hook does,
          // so retry on the slow cadence rather than every fast tick. The raw
          // guest path is never installed on Windows — it would resolve against
          // the current drive (`C:\home\…`) and bind chat to a look-alike file.
          lastWslTranslateAt = Date.now()
          hostReadableExactPath = await toHostReadableTranscriptPath(exactPath, {
            signal: resolveController.signal
          })
        }
      }
      result = hostReadableExactPath
        ? await attemptInstall(
            { ...args, filePath: hostReadableExactPath },
            decode,
            resolveController.signal
          )
        : null
      if (
        !result &&
        (!exactPath || Date.now() - lastFallbackResolveAt >= FALLBACK_RESOLVE_POLL_MS)
      ) {
        lastFallbackResolveAt = Date.now()
        result = await attemptInstall(args, decode, resolveController.signal)
      }
    } catch (error) {
      // Why: a transient resolve failure (EACCES/EIO during the glob) must not
      // kill the poll loop with an unhandled rejection — retry like a miss. A
      // stalled WSL distro would otherwise poll silently forever, leaving the
      // client at 'loading'; emit its retryable message once and keep polling,
      // so a later tick's real snapshot still replaces it. Narrowed with a bare
      // instanceof, never wslTranscriptFsRefusal — that helper rethrows, and
      // runAttempt is invoked as `void runAttempt()`.
      if (error instanceof WslTranscriptFsError && !gateErrorEmitted && args.onInitialSnapshot) {
        gateErrorEmitted = true
        args.onInitialSnapshot([], false, 0, error.message)
      }
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
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      resolveController.abort()
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
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): Promise<NativeChatTranscriptSubscription> {
  setupSignal?.throwIfAborted()
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    // Nothing watchable — return a no-op teardown so callers can unconditionally
    // unsubscribe without null-checks.
    return { unsubscribe: () => {}, watching: false }
  }
  // Why: a blank session id (and no explicit file) can never resolve — bail out
  // instead of resolve-polling an unresolvable target forever.
  if (!args.filePath && !args.sessionId.trim()) {
    return { unsubscribe: () => {}, watching: false }
  }

  let installed: NativeChatTranscriptSubscription | null
  try {
    installed = await attemptInstall(args, decode, setupSignal)
  } catch (error) {
    setupSignal?.throwIfAborted()
    // Why: a gate-refused resolve (stalled WSL distro) must degrade to the
    // resolve-poll fallback below, not fail the subscribe outright.
    void wslTranscriptFsRefusal(error) // rethrows anything that is not a gate refusal
    installed = null
  }
  if (installed) {
    return installed
  }
  setupSignal?.throwIfAborted()
  return subscribeViaResolvePoll(args, decode)
}
