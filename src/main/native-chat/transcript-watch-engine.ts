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
import { detectTranscriptReplacement } from './transcript-replacement-detection'
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

/** Install a live tail, or return null when the resolved file is not readable yet. */
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
  const { onAppend, onInitialSnapshot, onOpaqueAppend, onReplace, initialLimit } = args
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)

  const state = createIncrementalTranscriptState()
  let watchedVersion: TranscriptFileVersion | null = null
  let watchedBoundary = ''
  let initialDrain = true,
    initialErrorEmitted = false
  let closed = false
  // Why: teardown must abort every gated operation, including work queued by a drain.
  const gateAbort = new AbortController()
  let reading = false
  let pendingReadRequested = false
  let rotationRetryCount = 0

  function scheduleRotationRetry(): void {
    if (!closed) {
      rotationRetryCount = scheduler.scheduleRotationRetry(rotationRetryCount)
    }
  }

  async function readAndEmitAppends(): Promise<void> {
    let lifecycle: NativeChatTurnLifecycle | undefined
    let emitted = false
    const startOffset = state.offset
    const remaining = await readIncrementalTranscriptMessages(
      filePath,
      state,
      decode,
      (messages) => {
        if (!closed) {
          emitted = true
          onAppend(messages)
        }
      },
      decodeLifecycle ?? undefined,
      (nextLifecycle) => {
        lifecycle = nextLifecycle
      },
      gateAbort.signal
    )
    if (!closed && (remaining.length > 0 || lifecycle)) {
      emitted = true
      onAppend(remaining, lifecycle)
    }
    if (!closed && !emitted && state.offset > startOffset) {
      onOpaqueAppend?.()
    }
  }

  async function finishSuccessfulDrain(startVersion: TranscriptFileVersion): Promise<void> {
    watchedBoundary = await boundaryFingerprint(filePath, state.offset, gateAbort.signal)
    const completedVersion = await readTranscriptFileVersion(filePath, gateAbort.signal)
    if (transcriptFileVersionChanged(completedVersion, startVersion)) {
      // Why: a racing write or timestamp-only rewrite needs another pass.
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
    const { identityChanged, contentReplaced } = detectTranscriptReplacement(
      current,
      watchedVersion,
      state.offset,
      currentBoundary,
      watchedBoundary
    )
    if (identityChanged) {
      nativeWatcher.invalidate()
    }
    if (contentReplaced) {
      resetIncrementalTranscriptState(state)
    }
    // Why: subscriber callbacks may replace the path before the drain can finish.
    watchedVersion ??= current

    const replacementSnapshot =
      // Why: 0 is a valid window and must not fall back to an unbounded read.
      contentReplaced && !initialDrain && onReplace && initialLimit !== undefined
        ? await readNativeChatTranscriptTailFile(
            filePath,
            initialLimit,
            decode,
            false,
            undefined,
            decodeLifecycle,
            gateAbort.signal
          )
        : null
    if (closed) {
      return
    }
    if (replacementSnapshot && onReplace) {
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
        ? await readNativeChatTranscriptTailFile(
            filePath,
            initialLimit,
            decode,
            false,
            undefined,
            decodeLifecycle,
            gateAbort.signal
          )
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
          gateAbort.signal
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
          // Why: unlink/recreate detaches fs.watch; retry and surface one initial error.
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
