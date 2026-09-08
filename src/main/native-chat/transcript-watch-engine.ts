import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFileVersionChanged, type TranscriptFileVersion } from './transcript-file-version'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState
} from './transcript-incremental-reader'
import { emitTranscriptUnavailableSnapshot } from './transcript-unavailable-snapshot'
import { transcriptWatcherPathIsInstallable } from './transcript-watcher-install-probe'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import {
  createSourceAwareTranscriptNativeWatcher,
  probeTranscriptWatchFile,
  readTranscriptWatchFileVersion,
  readTranscriptWatchState,
  readTranscriptWatchTail,
  observeTranscriptWatchRunningState,
  createTranscriptWatchSubscription,
  createTranscriptWatchReconciler,
  createTranscriptWatchSchedulerForTranscript,
  activateTranscriptWatchRuntime,
  disposeTranscriptWatchRuntime
} from './transcript-watch-source-access'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'
import {
  isWslTranscriptWatcherPath,
  transcriptWatcherPathIsRunning
} from './wsl-transcript-watcher-running-guard'

/** Install a live tail, or return null when the resolved file is not readable yet. */
export async function installTranscriptWatcher(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  args: SubscribeNativeChatTranscriptArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptSubscription | null> {
  const fileSource = args.fileSource
  const isWslPath = isWslTranscriptWatcherPath(filePath)
  if (fileSource) {
    try {
      await probeTranscriptWatchFile(filePath, fileSource, signal)
    } catch {
      return null
    }
  } else if (!(await transcriptWatcherPathIsInstallable(filePath, signal))) {
    return null
  }
  const { onAppend, onInitialSnapshot, onReplace, initialLimit } = args
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)

  const state = createIncrementalTranscriptState()
  let watchedVersion: TranscriptFileVersion | null = null
  let watchedBoundary = ''
  let initialDrain = true,
    initialErrorEmitted = false
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
      { fileSource, signal: gateAbort.signal }
    )
    if (!closed && (remaining.length > 0 || lifecycle)) {
      onAppend(remaining, lifecycle)
    }
  }

  async function finishSuccessfulDrain(startVersion: TranscriptFileVersion): Promise<void> {
    const { boundary, version: completedVersion } = await readTranscriptWatchState(
      filePath,
      state.offset,
      fileSource,
      gateAbort.signal
    )
    watchedBoundary = boundary
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
    if (!isWslPath) {
      scheduleRotationRetry()
    }
  }

  async function drainOnce(): Promise<void> {
    const { version: current, boundary: currentBoundary } = await readTranscriptWatchState(
      filePath,
      state.offset,
      fileSource,
      gateAbort.signal
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
    // Why: subscriber callbacks may replace the path before the drain can finish.
    watchedVersion ??= current

    const replacementSnapshot =
      // Why: 0 is a valid window — an explicit undefined check keeps an empty
      // snapshot empty instead of falling back to an unbounded incremental read.
      contentReplaced && !initialDrain && onReplace && initialLimit !== undefined
        ? await readTranscriptWatchTail(
            filePath,
            initialLimit,
            decode,
            decodeLifecycle,
            fileSource,
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
        ? await readTranscriptWatchTail(
            filePath,
            initialLimit,
            decode,
            decodeLifecycle,
            fileSource,
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
          { fileSource, signal: gateAbort.signal }
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
          // Why: unlink/recreate can detach fs.watch from the pathname. Keep one
          // capped-backoff retry alive until a successor appears or we unsubscribe.
          // A still-pending initial drain also surfaces one error snapshot so a
          // watching client isn't stranded at 'loading' when the read keeps
          // throwing; initialDrain stays true so a recovered read can still win.
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

  const scheduleFrame = () => scheduler.scheduleEventDrain()
  const nativeWatcher = createSourceAwareTranscriptNativeWatcher(
    filePath,
    fileSource,
    scheduleFrame,
    scheduleRotationRetry
  )

  const reconcileKnownRunning = createTranscriptWatchReconciler({
    isClosed: () => closed,
    readVersion: () => readTranscriptWatchFileVersion(filePath, fileSource, gateAbort.signal),
    watchedVersion: () => watchedVersion,
    offset: () => state.offset,
    needsRebind: () => nativeWatcher.needsRebind(),
    drain: () => drain(true),
    isWslPath
  })
  const scheduler = createTranscriptWatchSchedulerForTranscript(
    args.debounceMs,
    args.reconciliationIntervalMs,
    () => void drain(),
    reconcileKnownRunning
  )
  const stopWslObservation = observeTranscriptWatchRunningState(
    filePath,
    isWslPath,
    reconcileKnownRunning,
    nativeWatcher
  )
  activateTranscriptWatchRuntime(isWslPath, scheduler, nativeWatcher)

  return createTranscriptWatchSubscription(() => {
    if (closed) {
      return
    }
    closed = true
    gateAbort.abort(new Error('Native Chat transcript watcher unsubscribed'))
    disposeTranscriptWatchRuntime(scheduler, stopWslObservation, nativeWatcher)
  })
}
