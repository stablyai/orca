import {
  isSshNativeChatAppendResult,
  isSshNativeChatUnchangedResult,
  type SshNativeChatRelayReadResult
} from '../../shared/ssh-native-chat-relay'
import { readSshNativeChatTranscript } from './ssh-transcript-host'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

// Why: `fs.watch` cannot reach a file on another machine, so a live SSH session
// is followed by polling the relay. The relay answers an unchanged file from a
// stat and a grown one with just the records past the caller's cursor, so an
// idle session costs one small round trip per tick and an active one ships the
// new turns rather than its whole window.
const INITIAL_POLL_MS = 1_000
const MAX_POLL_MS = 5_000
const DEFAULT_LIMIT = 40
// Why: this subscription exists because a never-arriving frame left the chat
// view spinning forever, so a relay that stays silent this long must say so.
// It is deliberately well past a reconnect: a transcript the agent has not
// flushed yet reports `notFound` and is never counted here, matching the local
// resolve-poll loop that waits it out (#8401).
const REPORT_UNAVAILABLE_AFTER_MS = 30_000
const REMOTE_UNAVAILABLE_MESSAGE = 'Transcript unavailable on the remote host'

export type SshTranscriptSubscriptionOptions = {
  /** Aborts setup and the poll loop, so both branches of the router honor a
   *  cancelled subscribe the same way. */
  signal?: AbortSignal
  /** Test-only override for the production poll backoff. */
  pollIntervalMs?: number
  /** Test-only override for the silence window before reporting. */
  reportUnavailableAfterMs?: number
}

export function subscribeSshNativeChatTranscript(
  connectionId: string,
  args: SubscribeNativeChatTranscriptArgs,
  options: SshTranscriptSubscriptionOptions = {}
): NativeChatTranscriptSubscription {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = options.pollIntervalMs ?? INITIAL_POLL_MS
  let snapshotDelivered = false
  let unavailableReported = false
  let silentSince: number | null = null
  let knownFileSize: number | undefined
  let generation: string | undefined
  // The path the relay resolved, echoed back so it does not re-walk the remote
  // agent home on every tick. Relay-authored, never the client's own param.
  let resolvedPath = args.transcriptPath
  const controller = new AbortController()

  const subscription: NativeChatTranscriptSubscription = {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      options.signal?.removeEventListener('abort', subscription.unsubscribe)
      controller.abort()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
  const limit = args.initialLimit ?? DEFAULT_LIMIT

  function schedule(): void {
    if (closed) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, delay)
    // Why: never hold the event loop open for a session that may never resolve
    // (headless `orca serve` shutdown), matching the local resolve-poll loop.
    timer.unref?.()
    if (options.pollIntervalMs === undefined) {
      delay = Math.min(delay * 2, MAX_POLL_MS)
    }
  }

  async function poll(): Promise<void> {
    if (closed) {
      return
    }
    let result: SshNativeChatRelayReadResult | null = null
    // Why: a dropped relay or a reconnecting target is not a dead session. Keep
    // polling so it recovers on its own, exactly like the local resolve-poll
    // loop, and report only once the silence gets long.
    let transportFailed = false
    try {
      result = await readSshNativeChatTranscript(
        connectionId,
        {
          agent: args.agent,
          sessionId: args.sessionId,
          ...(resolvedPath === undefined ? {} : { transcriptPath: resolvedPath }),
          limit,
          ...(knownFileSize === undefined ? {} : { knownFileSize }),
          ...(generation === undefined ? {} : { generation })
        },
        controller.signal
      )
    } catch {
      transportFailed = true
    }
    if (closed) {
      return
    }
    try {
      if (transportFailed) {
        noteSilence()
      } else {
        deliver(result)
      }
    } catch (error) {
      // Why: a subscriber fault is neither relay silence nor a reason to stop.
      // Every callback this loop makes runs inside this guard so a renderer that
      // throws cannot take the poll loop down with it, and the delivery state is
      // left untouched so the next tick retries the same frame.
      console.warn('[ssh-transcript] native chat subscriber threw on a frame', error)
    }
    schedule()
  }

  function deliver(result: SshNativeChatRelayReadResult | null): void {
    if (!result) {
      noteSilence()
      return
    }
    if ('error' in result) {
      // A transcript the agent has not written yet is exactly the #8401 case the
      // local loop waits out, so it must not settle the view. Any other error is
      // a real failure and counts toward the silence report.
      if (!result.notFound) {
        noteSilence()
      }
      return
    }
    silentSince = null
    if ('filePath' in result && typeof result.filePath === 'string') {
      resolvedPath = result.filePath
    }
    if (isSshNativeChatUnchangedResult(result)) {
      knownFileSize = result.fileSize
      generation = result.generation
      return
    }
    if (isSshNativeChatAppendResult(result)) {
      if (!snapshotDelivered) {
        // Nothing has been rendered yet, so an append has no window to extend:
        // drop the cursor and let the next tick deliver a full one.
        knownFileSize = undefined
        generation = undefined
        return
      }
      if (result.appended.length > 0) {
        args.onAppend(result.appended, result.lifecycle)
      }
      knownFileSize = result.fileSize
      generation = result.generation
      resetBackoff()
      return
    }
    if (snapshotDelivered) {
      // Full windows only arrive here when the file was replaced or truncated,
      // which is the same signal the local watcher reports as a replacement.
      args.onReplace?.(result.messages, result.hasMore, result.beforeOffset, result.lifecycle)
    } else {
      args.onInitialSnapshot?.(
        result.messages,
        result.hasMore,
        result.beforeOffset,
        undefined,
        result.lifecycle
      )
      // Why: set AFTER the callback returns. A subscriber that throws on the
      // first frame must re-enter this branch next tick; flipping the flag first
      // would route the retry to onReplace, leave the client with no snapshot,
      // and suppress the silence report, which is the exact bug this
      // subscription exists to fix.
      snapshotDelivered = true
    }
    // Advance the cursor only once the frame is out, so a throwing subscriber
    // cannot make the next poll answer `unchanged` and lose those records.
    knownFileSize = result.fileSize
    generation = result.generation
    resetBackoff()
  }

  /** Why: reset only after a frame was actually delivered. Resetting before the
   *  callback would pin a subscriber that throws on every frame at the fastest
   *  tick, re-reading the whole remote window once a second forever. */
  function resetBackoff(): void {
    delay = options.pollIntervalMs ?? INITIAL_POLL_MS
  }

  /** Emits one error-carrying frame after a long silence so a client that has
   *  drawn nothing can leave its loading state. Never emitted twice, and never
   *  after real content: a recovered poll reports like any other update. */
  function noteSilence(): void {
    const now = Date.now()
    silentSince ??= now
    const window = options.reportUnavailableAfterMs ?? REPORT_UNAVAILABLE_AFTER_MS
    if (snapshotDelivered || unavailableReported || now - silentSince < window) {
      return
    }
    args.onInitialSnapshot?.([], false, 0, REMOTE_UNAVAILABLE_MESSAGE)
    // Set after the call for the same reason as snapshotDelivered: a subscriber
    // that throws on this frame must be offered it again.
    unavailableReported = true
  }

  if (options.signal?.aborted) {
    closed = true
    controller.abort()
    return { watching: false, unsubscribe: () => {} }
  }
  options.signal?.addEventListener('abort', subscription.unsubscribe, { once: true })

  void poll()

  return subscription
}
