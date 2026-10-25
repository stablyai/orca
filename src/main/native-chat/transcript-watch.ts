import { UNFLUSHED_SETTLE_MS } from './transcript-watch-contract'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { extname } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  needsWslHostResolution,
  toHostReadableTranscriptPath,
  type WslTranscriptResolutionSnapshot
} from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'
import { installTranscriptWatcher } from './transcript-watch-engine'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import { WslTranscriptFsError, wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'
import { observeRunningWslDistros } from './wsl-transcript-running-observer'

export { readNativeChatTranscriptTail } from './transcript-tail-reader'
export { getActiveNativeChatWatcherCount } from './transcript-watcher-count'
export type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

/** Unresolved files retry; native watch failure still permits reconciliation-only mode. */
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

// First flush may take minutes; poll exact hook paths often and expensive session-ID discovery less often.
const INITIAL_RESOLVE_POLL_MS = 500
const MAX_RESOLVE_POLL_MS = 5_000
const FALLBACK_RESOLVE_POLL_MS = 5_000

function exactTranscriptPath(args: SubscribeNativeChatTranscriptArgs): string | null {
  const path = args.transcriptPath?.trim()
  return path && extname(path) === '.jsonl' ? path : null
}

/** Return a live subscription while resolve/install retries; pending feedback must not claim settled history. */
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
  const exactPathNeedsWslResolution = exactPath !== null && needsWslHostResolution(exactPath)
  // Lazily translate WSL guest paths so exact-path retries avoid the slower ID scan.
  let hostReadableExactPath: string | null = null
  // Latch only after actual delivery; absent callbacks must not suppress future feedback.
  let gateErrorEmitted = false
  let settled = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const resolveController = new AbortController()
  let stopWslObservation = (): void => {}

  function stopSettleTimer(): void {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  /** Pending is not an empty snapshot: retained history and transcript-dependent consumers must stay intact. */
  function settleUnflushed(): void {
    settleTimer = null
    if (closed || settled || installed || !args.onTranscriptPending) {
      return
    }
    settled = true
    args.onTranscriptPending()
  }

  if (args.onTranscriptPending) {
    settleTimer = setTimeout(settleUnflushed, UNFLUSHED_SETTLE_MS)
    settleTimer.unref?.()
  }

  function scheduleAttempt(): void {
    if (closed || exactPathNeedsWslResolution) {
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
    // Unresolved sessions must not keep headless host shutdown alive.
    pollTimer.unref?.()
    if (args.resolvePollIntervalMs === undefined) {
      delay = Math.min(delay * 2, MAX_RESOLVE_POLL_MS)
    }
  }

  async function runAttempt(wslSnapshot?: WslTranscriptResolutionSnapshot): Promise<void> {
    if (closed || installed) {
      return
    }
    let result: NativeChatTranscriptSubscription | null
    const now = Date.now()
    const fallbackDue = !exactPath || now - lastFallbackResolveAt >= FALLBACK_RESOLVE_POLL_MS
    try {
      if (exactPath && !hostReadableExactPath) {
        if (!exactPathNeedsWslResolution) {
          // Native install handles missing paths; avoid another probe per tick.
          hostReadableExactPath = exactPath
        } else if (wslSnapshot) {
          // Raw guest paths on Windows can bind a local look-alike on the current drive.
          hostReadableExactPath = await toHostReadableTranscriptPath(exactPath, {
            signal: resolveController.signal,
            wslSnapshot
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
      if (!result && exactPathNeedsWslResolution) {
        hostReadableExactPath = null
      }
      if (!result && fallbackDue && !exactPathNeedsWslResolution) {
        lastFallbackResolveAt = now
        result = await attemptInstall(args, decode, resolveController.signal)
      }
    } catch (error) {
      if (exactPathNeedsWslResolution) {
        hostReadableExactPath = null
      }
      // Retry transient failures without escaping void runAttempt; show WSL refusal once while recovery continues.
      // Use instanceof: wslTranscriptFsRefusal rethrows unrelated errors and would kill this loop.
      if (error instanceof WslTranscriptFsError && !gateErrorEmitted && args.onInitialSnapshot) {
        gateErrorEmitted = true
        settled = true
        stopSettleTimer()
        args.onInitialSnapshot([], false, 0, error.message)
      }
      result = null
    }
    if (closed) {
      result?.unsubscribe()
      return
    }
    if (result) {
      installed = result
      stopWslObservation()
      stopWslObservation = () => {}
      stopSettleTimer()
      return
    }
    scheduleAttempt()
  }

  if (exactPathNeedsWslResolution) {
    stopWslObservation = observeRunningWslDistros((runningDistros) =>
      runAttempt({ runningDistros: [...runningDistros] })
    )
  } else {
    scheduleAttempt()
  }

  return {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      resolveController.abort()
      stopWslObservation()
      stopWslObservation = () => {}
      stopSettleTimer()
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      installed?.unsubscribe()
      installed = null
    }
  }
}

/** Tail appends and reset offsets on replacement; unresolved first flushes retry until teardown. */
export async function subscribeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): Promise<NativeChatTranscriptSubscription> {
  setupSignal?.throwIfAborted()
  if (resolveNativeChatTranscriptAgent(args.agent) === 'opencode') {
    return subscribeOpenCodeNativeChatTranscript(
      args,
      setupSignal,
      {},
      args.agent === 'zcode' ? 'zcode' : undefined
    )
  }
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { unsubscribe: () => {}, watching: false }
  }
  // Blank targets can never resolve; do not poll forever.
  if (!args.filePath && !args.sessionId.trim()) {
    return { unsubscribe: () => {}, watching: false }
  }

  let installed: NativeChatTranscriptSubscription | null
  try {
    installed = await attemptInstall(args, decode, setupSignal)
  } catch (error) {
    setupSignal?.throwIfAborted()
    // Gate refusal must enter retry polling rather than fail subscription setup.
    void wslTranscriptFsRefusal(error) // rethrows non-gate failures
    installed = null
  }
  if (installed) {
    return installed
  }
  setupSignal?.throwIfAborted()
  return subscribeViaResolvePoll(args, decode)
}
