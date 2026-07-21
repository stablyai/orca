import { open, stat } from 'node:fs/promises'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'
import {
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import { createTranscriptNativeWatcher } from './transcript-native-watcher'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'

const ROTATION_RETRY_MS = 25
const MAX_ROTATION_RETRY_MS = 2_000
let activeWatcherCount = 0

export function getActiveNativeChatWatcherCount(): number {
  return activeWatcherCount
}

async function boundaryFingerprint(filePath: string, offset: number): Promise<string> {
  if (offset <= 0) {
    return ''
  }
  const start = Math.max(0, offset - 64)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(offset - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead).toString('base64')
  } finally {
    await handle.close()
  }
}

/**
 * Install the live-tail engine on an already-resolved file path. Returns null
 * when the file doesn't exist yet, so the caller falls back to resolve-polling.
 * A failed native watch still installs a reconciliation-only subscription: some
 * remote filesystems allow stat/read while rejecting fs.watch entirely.
 */
export async function installTranscriptWatcher(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  args: SubscribeNativeChatTranscriptArgs
): Promise<NativeChatTranscriptSubscription | null> {
  try {
    await stat(filePath)
  } catch {
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
      }
    )
    if (!closed && (remaining.length > 0 || lifecycle)) {
      onAppend(remaining, lifecycle)
    }
  }

  async function finishSuccessfulDrain(startVersion: TranscriptFileVersion): Promise<void> {
    watchedBoundary = await boundaryFingerprint(filePath, state.offset)
    const completedVersion = await readTranscriptFileVersion(filePath)
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
    const current = await readTranscriptFileVersion(filePath)
    const currentBoundary = await boundaryFingerprint(filePath, state.offset)
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

    const replacementSnapshot =
      // Why: 0 is a valid window — an explicit undefined check keeps an empty
      // snapshot empty instead of falling back to an unbounded incremental read.
      contentReplaced && !initialDrain && onReplace && initialLimit !== undefined
        ? await readNativeChatTranscriptTailFile(
            filePath,
            initialLimit,
            decode,
            false,
            undefined,
            decodeLifecycle
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
            decodeLifecycle
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
          }
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
        } catch {
          // Why: unlink/recreate can detach fs.watch from the pathname. Keep one
          // capped-backoff retry alive until a successor appears or we unsubscribe.
          // A still-pending initial drain also surfaces one error snapshot so a
          // watching client isn't stranded at 'loading' when the read keeps
          // throwing; initialDrain stays true so a recovered read can still win.
          if (!closed && initialDrain && onInitialSnapshot && !initialErrorEmitted) {
            initialErrorEmitted = true
            onInitialSnapshot([], false, 0, 'Transcript unavailable')
          }
          scheduleRotationRetry()
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
      const current = await readTranscriptFileVersion(filePath)
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
  const nativeWatcher = createTranscriptNativeWatcher(
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
      scheduler.dispose()
      nativeWatcher.dispose()
      activeWatcherCount--
    }
  }
}
