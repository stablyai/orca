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
  // The path the relay resolved, echoed back so it does not re-walk the remote
  // agent home on every tick. Relay-authored, never the client's own param.
  let resolvedPath = args.transcriptPath
  const controller = new AbortController()
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
    try {
      const result = await readSshNativeChatTranscript(
        connectionId,
        {
          agent: args.agent,
          sessionId: args.sessionId,
          ...(resolvedPath === undefined ? {} : { transcriptPath: resolvedPath }),
          limit,
          ...(knownFileSize === undefined ? {} : { knownFileSize })
        },
        controller.signal
      )
      if (closed) {
        return
      }
      deliver(result)
    } catch {
      // Why: a dropped relay or a reconnecting target is not a dead session.
      // Keep polling so it recovers on its own, exactly like the local
      // resolve-poll loop, and report only once the silence gets long.
      if (!closed) {
        noteSilence()
      }
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
      // local loop waits out, so it must not settle the view.
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
      return
    }
    // A live file resets the backoff so the next append lands fast.
    delay = options.pollIntervalMs ?? INITIAL_POLL_MS
    if (isSshNativeChatAppendResult(result)) {
      if (!snapshotDelivered) {
        // Nothing has been rendered yet, so an append has no window to extend:
        // take the cursor and let the next tick deliver a full one.
        knownFileSize = undefined
        return
      }
      if (result.appended.length > 0) {
        args.onAppend(result.appended, result.lifecycle)
      }
      knownFileSize = result.fileSize
      return
    }
    if (snapshotDelivered) {
      // Full windows only arrive here when the file was replaced or truncated,
      // which is the same signal the local watcher reports as a replacement.
      args.onReplace?.(result.messages, result.hasMore, result.beforeOffset, result.lifecycle)
    } else {
      snapshotDelivered = true
      args.onInitialSnapshot?.(
        result.messages,
        result.hasMore,
        result.beforeOffset,
        undefined,
        result.lifecycle
      )
    }
    // Advance the cursor only once the frame is out, so a throwing subscriber
    // cannot make the next poll answer `unchanged` and lose those records.
    knownFileSize = result.fileSize
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
    unavailableReported = true
    args.onInitialSnapshot?.([], false, 0, REMOTE_UNAVAILABLE_MESSAGE)
  }

  void poll()

  return {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      controller.abort()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
