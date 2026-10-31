import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  boundaryFingerprint,
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState
} from './transcript-incremental-reader'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'
import { emitTranscriptUnavailableSnapshot } from './transcript-unavailable-snapshot'
import { transcriptWatcherPathIsInstallable } from './transcript-watcher-install-probe'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'
import {
  createRunningGuardedTranscriptNativeWatcher,
  isWslTranscriptWatcherPath,
  transcriptWatcherPathIsRunning
} from './wsl-transcript-watcher-running-guard'
import { observeWslTranscriptRunningState } from './wsl-transcript-running-observer'
import { trackActiveNativeChatWatcher } from './transcript-watcher-count'

export async function installTranscriptWatcher(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  args: SubscribeNativeChatTranscriptArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptSubscription | null> {
  const isWslPath = isWslTranscriptWatcherPath(filePath)
  if (!(await transcriptWatcherPathIsInstallable(filePath, signal))) {
    return null
  }
  const { onAppend, onInitialSnapshot, onReplace, initialLimit } = args
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)

  const state = createIncrementalTranscriptState()
  let watchedVersion: TranscriptFileVersion | null = null
  let initialDrain = true,
    initialErrorEmitted = false
  let closed = false
  // Abort detaches gate waiters immediately and prevents in-flight drains admitting work after teardown.
  const gateAbort = new AbortController()
  let reading = false
  let pendingReadRequested = false
  let rotationRetryCount = 0

  function scheduleRotationRetry(): void {
    if (closed) {
      return
    }
    const retryDelay = Math.min(25 * 2 ** Math.min(rotationRetryCount, 7), 2_000)
    if (scheduler.scheduleRetry(retryDelay)) {
      rotationRetryCount += 1
    }
  }

  async function readAndEmitAppends(): Promise<void> {
    let lifecycle: NativeChatTurnLifecycle | undefined
    const remaining = await readIncrementalTranscriptMessages(
      filePath,
      state,
      decode,
      (messages) => {
        if (!closed) {
          onAppend(messages)
        }
      },
      decodeLifecycle ?? undefined,
      (nextLifecycle) => {
        lifecycle = nextLifecycle
      },
      gateAbort.signal,
      args.sourceOrder
    )
    if (!closed && (remaining.length > 0 || lifecycle)) {
      onAppend(remaining, lifecycle)
    }
  }

  async function readSnapshot(limit: number) {
    return readNativeChatTranscriptTailFile(
      filePath,
      limit,
      decode,
      false,
      undefined,
      decodeLifecycle,
      gateAbort.signal,
      (boundary) => {
        state.boundary = boundary
      },
      args.sourceOrder
    )
  }

  async function finishSuccessfulDrain(startVersion: TranscriptFileVersion): Promise<void> {
    const completedVersion = await readTranscriptFileVersion(filePath, gateAbort.signal)
    if (transcriptFileVersionChanged(completedVersion, startVersion)) {
      // Writes racing this drain need another pass even at new EOF; timestamp-only rewrites may replace content.
      watchedVersion = startVersion
      pendingReadRequested = true
    } else {
      watchedVersion = completedVersion
    }
    pendingReadRequested ||= completedVersion.size !== state.offset
    if (closed) {
      return
    }
    if (!nativeWatcher.needsRebind() || nativeWatcher.bind()) {
      rotationRetryCount = 0
      return
    }
    if (!isWslPath) {
      scheduleRotationRetry()
    }
  }

  async function drainOnce(): Promise<void> {
    const current = await readTranscriptFileVersion(filePath, gateAbort.signal)
    const currentBoundary = await boundaryFingerprint(filePath, state.offset, gateAbort.signal)
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
      (state.offset > 0 && state.boundary.toString('base64') !== currentBoundary)
    if (identityChanged) {
      nativeWatcher.invalidate()
    }
    if (contentReplaced) {
      resetIncrementalTranscriptState(state)
    }
    watchedVersion ??= current

    const replacementSnapshot =
      // Zero is a valid bounded window; do not fall back to an unbounded incremental read.
      contentReplaced && !initialDrain && onReplace && initialLimit !== undefined
        ? await readSnapshot(initialLimit)
        : null
    if (closed) {
      return
    }
    if (replacementSnapshot && onReplace) {
      state.offset = replacementSnapshot.consumedTo
      state.pendingStart = state.offset
      state.latestTimestamp = replacementSnapshot.latestTimestamp ?? Number.NEGATIVE_INFINITY
      onReplace(
        replacementSnapshot.messages,
        replacementSnapshot.hasMore,
        replacementSnapshot.beforeOffset,
        replacementSnapshot.lifecycle
      )
      await finishSuccessfulDrain(current)
      return
    }

    const initialSnapshot =
      initialDrain && onInitialSnapshot && initialLimit !== undefined
        ? await readSnapshot(initialLimit)
        : null
    if (closed) {
      return
    }
    if (initialDrain && onInitialSnapshot) {
      initialDrain = false
      if (initialSnapshot) {
        state.offset = initialSnapshot.consumedTo
        state.pendingStart = state.offset
        state.latestTimestamp = initialSnapshot.latestTimestamp ?? Number.NEGATIVE_INFINITY
        onInitialSnapshot(
          initialSnapshot.messages,
          initialSnapshot.hasMore,
          initialSnapshot.beforeOffset,
          undefined,
          initialSnapshot.lifecycle
        )
      } else {
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
          args.sourceOrder
        )
        if (closed) {
          return
        }
        onInitialSnapshot(messages, false, 0, undefined, lifecycle)
      }
    } else {
      initialDrain = false
      await readAndEmitAppends()
    }
    await finishSuccessfulDrain(current)
  }

  async function drain(runningChecked = false): Promise<void> {
    if (closed) {
      return
    }
    if (isWslPath && !runningChecked && !(await transcriptWatcherPathIsRunning(filePath))) {
      nativeWatcher.invalidate()
      initialErrorEmitted ||=
        !closed && initialDrain && emitTranscriptUnavailableSnapshot(onInitialSnapshot)
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
          // Recreated files detach fs.watch: retry with capped backoff until replacement or teardown.
          // Report one initial error but retain initialDrain so recovery can replace it with a real snapshot.
          initialErrorEmitted ||=
            !closed &&
            initialDrain &&
            emitTranscriptUnavailableSnapshot(
              onInitialSnapshot,
              error instanceof WslTranscriptFsError ? error.message : 'Transcript unavailable'
            )
          if (!isWslPath) {
            scheduleRotationRetry()
          }
          break
        }
      } while (pendingReadRequested && !closed)
    } finally {
      reading = false
    }
  }

  async function reconcileKnownRunning(): Promise<void> {
    if (closed) {
      return
    }
    try {
      const current = await readTranscriptFileVersion(filePath, gateAbort.signal)
      if (closed) {
        return
      }
      const versionChanged =
        watchedVersion === null || transcriptFileVersionChanged(current, watchedVersion)
      if (versionChanged || current.size !== state.offset || nativeWatcher.needsRebind()) {
        await drain(true)
      }
    } catch {
      // WSL retries wait for the next shared running-state observation.
      await (isWslPath ? undefined : drain())
    }
  }

  const scheduler = createTranscriptWatchScheduler({
    debounceMs: args.debounceMs,
    reconciliationIntervalMs: args.reconciliationIntervalMs,
    drain: () => void drain(),
    reconcile: reconcileKnownRunning
  })
  const nativeWatcher = createRunningGuardedTranscriptNativeWatcher(
    filePath,
    () => scheduler.scheduleEventDrain(),
    scheduleRotationRetry
  )

  nativeWatcher.bind()
  const stopWslObservation = isWslPath
    ? observeWslTranscriptRunningState(
        filePath,
        () => reconcileKnownRunning(),
        () => nativeWatcher.invalidate()
      )
    : () => {}
  trackActiveNativeChatWatcher(1)
  if (!isWslPath) {
    scheduler.startReconciliation()
  }
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
      stopWslObservation()
      nativeWatcher.dispose()
      trackActiveNativeChatWatcher(-1)
    }
  }
}
