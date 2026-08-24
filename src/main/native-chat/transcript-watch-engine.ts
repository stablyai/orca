import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  boundaryFingerprint,
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'
import {
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import {
  createIdleTranscriptNativeWatcher,
  createTranscriptNativeWatcher
} from './transcript-native-watcher'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import * as watchRead from './transcript-watch-read'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'
import { wslGatedStat } from './wsl-transcript-fs-access'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'
import {
  isTranscriptHostUnverifiableError,
  transcriptInitialReadErrorMessage
} from './transcript-host-verdict'
import { TranscriptRangeReadInvalidatedError } from './transcript-range-fs'

const ROTATION_RETRY_MS = 25
const MAX_ROTATION_RETRY_MS = 2_000
let activeWatcherCount = 0

export const getActiveNativeChatWatcherCount = (): number => activeWatcherCount

/** Installs a live tail on an already-resolved path; missing files return null. */
export async function installTranscriptWatcher(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  args: SubscribeNativeChatTranscriptArgs,
  /** Cancels an in-flight install probe when the subscriber leaves. */
  signal?: AbortSignal
): Promise<NativeChatTranscriptSubscription | null> {
  const rangeFs = args.rangeFs
  try {
    await (rangeFs ? rangeFs.stat(filePath, signal) : wslGatedStat(filePath, 'exact', signal))
  } catch (error) {
    // Why: "not flushed yet" degrades to resolve-polling, but a stalled distro
    // must reach the caller so it can surface a retryable message instead of
    // stranding the client at `loading`.
    if (error instanceof WslTranscriptFsError || isTranscriptHostUnverifiableError(error)) {
      throw error
    }
    return null
  }
  const { onAppend, onInitialSnapshot, onReplace, initialLimit } = args
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)

  const state: IncrementalTranscriptState = {
    offset: 0,
    pendingChunks: [],
    pendingStart: 0,
    pendingBytes: 0,
    droppingOversizedRecord: false
  }
  let watchedVersion: TranscriptFileVersion | null = null
  let watchedBoundary = ''
  let initialDrain = true
  // Guards the one-time error snapshot emitted when the initial drain throws, so
  // a persistently-failing retry loop can't spam the subscriber with error frames.
  let initialErrorEmitted = false
  let closed = false
  // Why: every gated call on the drain path must detach the moment we
  // unsubscribe, instead of holding a waiter until its 30s deadline, and an
  // aborted signal also makes the gate refuse admission for anything the
  // in-flight drain would start after teardown.
  const gateAbort = new AbortController()
  let reading = false
  let pendingReadRequested = false
  let rotationRetryCount = 0

  function scheduleRotationRetry(): void {
    if (closed) {
      return
    }
    const retryDelay = Math.min(
      ROTATION_RETRY_MS * 2 ** Math.min(rotationRetryCount, 7),
      MAX_ROTATION_RETRY_MS
    )
    if (scheduler.scheduleRetry(retryDelay)) {
      rotationRetryCount += 1
    }
  }

  const watchReadContext = {
    filePath,
    state,
    decode,
    decodeLifecycle,
    signal: gateAbort.signal,
    rangeFs
  }

  function readAndEmitAppends(): Promise<void> {
    return watchRead.emitTranscriptWatchAppends(watchReadContext, onAppend, () => closed)
  }

  async function readInitialTranscript(): Promise<{
    messages: NativeChatMessage[]
    lifecycle?: NativeChatTurnLifecycle
  }> {
    let lifecycle: NativeChatTurnLifecycle | undefined
    const messages = await readIncrementalTranscriptMessages(
      filePath,
      state,
      decode,
      undefined,
      decodeLifecycle ?? undefined,
      (nextLifecycle) => {
        lifecycle = nextLifecycle
      },
      gateAbort.signal,
      rangeFs
    )
    return { messages, ...(lifecycle ? { lifecycle } : {}) }
  }

  async function finishSuccessfulDrain(startVersion: TranscriptFileVersion): Promise<void> {
    watchedBoundary = await boundaryFingerprint(filePath, state.offset, gateAbort.signal, rangeFs)
    const completedVersion = await readTranscriptFileVersion(filePath, gateAbort.signal, rangeFs)
    if (transcriptFileVersionChanged(completedVersion, startVersion)) {
      // Why: a write racing this drain needs another pass even when the reader
      // happened to reach its new EOF; timestamp-only rewrites may need replace.
      watchedVersion = startVersion
      pendingReadRequested = true
    } else {
      watchedVersion = completedVersion
    }
    if (closed) {
      return
    }
    if (!nativeWatcher.needsRebind() || nativeWatcher.bind()) {
      rotationRetryCount = 0
      return
    }
    scheduleRotationRetry()
  }

  async function drainOnce(): Promise<void> {
    const current = await readTranscriptFileVersion(filePath, gateAbort.signal, rangeFs)
    const currentBoundary = await boundaryFingerprint(
      filePath,
      state.offset,
      gateAbort.signal,
      rangeFs
    )
    if (closed) {
      return
    }
    const identityChanged = watchedVersion !== null && current.identity !== watchedVersion.identity
    const sameSizeVersionChanged =
      watchedVersion !== null &&
      current.identity === watchedVersion.identity &&
      current.size === watchedVersion.size &&
      transcriptFileVersionChanged(current, watchedVersion)
    const contentReplaced =
      identityChanged ||
      sameSizeVersionChanged ||
      current.size < state.offset ||
      (state.offset > 0 && watchedBoundary !== currentBoundary)
    if (identityChanged) {
      nativeWatcher.invalidate()
    }
    if (contentReplaced) {
      resetIncrementalTranscriptState(state)
    }
    watchedVersion ??= current
    const replacementSnapshot =
      (contentReplaced ||
        watchRead.replaceRemoteCatchup(current.size - state.offset, initialDrain, args)) &&
      !initialDrain &&
      onReplace &&
      initialLimit !== undefined
        ? await watchRead.readTranscriptWatchSnapshot(watchReadContext, initialLimit)
        : null
    if (closed) {
      return
    }
    if (replacementSnapshot && onReplace) {
      resetIncrementalTranscriptState(state)
      state.offset = replacementSnapshot.consumedTo
      state.pendingStart = state.offset
      onReplace(
        replacementSnapshot.messages,
        replacementSnapshot.hasMore,
        replacementSnapshot.beforeOffset,
        replacementSnapshot.lifecycle
      )
      await readAndEmitAppends()
      await finishSuccessfulDrain(current)
      return
    }

    const initialSnapshot =
      initialDrain && onInitialSnapshot && initialLimit !== undefined
        ? await watchRead.readTranscriptWatchSnapshot(watchReadContext, initialLimit)
        : null
    if (closed) {
      return
    }
    if (initialDrain && onInitialSnapshot) {
      initialDrain = false
      if (initialSnapshot) {
        state.offset = initialSnapshot.consumedTo
        state.pendingStart = state.offset
        onInitialSnapshot(
          initialSnapshot.messages,
          initialSnapshot.hasMore,
          initialSnapshot.beforeOffset,
          undefined,
          initialSnapshot.lifecycle
        )
        await readAndEmitAppends()
      } else {
        const initial = await readInitialTranscript()
        if (closed) {
          return
        }
        onInitialSnapshot(initial.messages, false, 0, undefined, initial.lifecycle)
      }
    } else {
      initialDrain = false
      await readAndEmitAppends()
    }
    await finishSuccessfulDrain(current)
  }

  async function drain(): Promise<void> {
    if (closed) {
      return
    }
    if (reading) {
      pendingReadRequested = true
      return
    }
    reading = true
    try {
      do {
        pendingReadRequested = false
        try {
          await drainOnce()
        } catch (error) {
          // Why: unlink/recreate can detach fs.watch from the pathname. Keep one
          // capped-backoff retry alive until a successor appears or we unsubscribe.
          // A still-pending initial drain also surfaces one error snapshot so a
          // watching client isn't stranded at 'loading' when the read keeps
          // throwing; initialDrain stays true so a recovered read can still win.
          scheduleRotationRetry()
          if (
            !closed &&
            initialDrain &&
            onInitialSnapshot &&
            !initialErrorEmitted &&
            !(error instanceof TranscriptRangeReadInvalidatedError)
          ) {
            initialErrorEmitted = true
            try {
              onInitialSnapshot([], false, 0, transcriptInitialReadErrorMessage(error))
            } catch {
              // A closing subscriber cannot own retry liveness.
            }
          }
          break
        }
      } while (pendingReadRequested && !closed)
    } finally {
      reading = false
    }
  }

  async function reconcile(): Promise<void> {
    if (closed) {
      return
    }
    try {
      const current = await readTranscriptFileVersion(filePath, gateAbort.signal, rangeFs)
      if (closed) {
        return
      }
      const versionChanged =
        watchedVersion === null || transcriptFileVersionChanged(current, watchedVersion)
      if (versionChanged || current.size !== state.offset || nativeWatcher.needsRebind()) {
        await drain()
      }
    } catch {
      // Why: a missing/replaced path needs the existing capped rotation retry,
      // even when fs.watch stayed silent about the transition.
      await drain()
    }
  }

  const scheduler = createTranscriptWatchScheduler({
    debounceMs: args.debounceMs,
    reconciliationIntervalMs: args.reconciliationIntervalMs,
    drain: () => void drain(),
    reconcile
  })
  const nativeWatcher = rangeFs
    ? createIdleTranscriptNativeWatcher()
    : createTranscriptNativeWatcher(
        filePath,
        () => scheduler.scheduleEventDrain(),
        scheduleRotationRetry
      )

  nativeWatcher.bind()
  activeWatcherCount++
  scheduler.startReconciliation()
  scheduler.scheduleEventDrain()

  return {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      gateAbort.abort(new Error('Native Chat transcript watcher unsubscribed'))
      scheduler.dispose()
      nativeWatcher.dispose()
      activeWatcherCount--
    }
  }
}
