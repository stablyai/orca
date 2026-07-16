import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from './session-file-resolver'
import {
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[]) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    /** Set when the initial drain could not deliver a transcript; the subscriber
     *  surfaces it as an error snapshot so a watching client never sticks on
     *  'loading'. Empty messages accompany it. */
    error?: string
  ) => void
  onReplace?: (messages: NativeChatMessage[], hasMore: boolean, beforeOffset: number) => void
  initialLimit?: number
  filePath?: string
  debounceMs?: number
  /** Overrides the resolve-poll interval (see subscribeViaResolvePoll) so tests
   *  don't wait out the production backoff. Production ignores this and backs
   *  off from 500ms to a 5s cap. */
  resolvePollIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}

const DEFAULT_DEBOUNCE_MS = 40
const ROTATION_RETRY_MS = 25
const MAX_ROTATION_RETRY_MS = 2_000
let activeWatcherCount = 0

export function getActiveNativeChatWatcherCount(): number {
  return activeWatcherCount
}

async function fileVersion(filePath: string): Promise<{ identity: string; size: number }> {
  const value = await stat(filePath)
  return { identity: `${value.dev}:${value.ino}`, size: value.size }
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
 * (rather than throwing) when the file doesn't exist yet or `watch()` fails —
 * e.g. an explicit transcriptPath whose first JSONL line hasn't flushed, or a
 * file that vanished between resolve and install — so the caller falls back to
 * the resolve-poll below instead of surfacing a hard error (#8401). The
 * existence gate matters because the engine watches the parent directory (see
 * bindWatcher), which succeeds even when the file itself is missing.
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
  const { onAppend, onInitialSnapshot, onReplace, initialLimit, debounceMs } = args

  const state: IncrementalTranscriptState = {
    offset: 0,
    pendingChunks: [],
    pendingStart: 0,
    pendingBytes: 0,
    droppingOversizedRecord: false
  }
  let watchedIdentity: string | null = null
  let watchedBoundary = ''
  let initialDrain = true
  // Guards the one-time error snapshot emitted when the initial drain throws, so
  // a persistently-failing retry loop can't spam the subscriber with error frames.
  let initialErrorEmitted = false
  let closed = false
  let reading = false
  let pendingReadRequested = false
  let rotationRetryCount = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  let watcherNeedsRebind = false

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

  function scheduleRotationRetry(): void {
    if (closed || debounceTimer) {
      return
    }
    const retryDelay = Math.min(
      ROTATION_RETRY_MS * 2 ** Math.min(rotationRetryCount, 7),
      MAX_ROTATION_RETRY_MS
    )
    rotationRetryCount += 1
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void drain()
    }, retryDelay)
  }

  async function readAndEmitAppends(): Promise<void> {
    const remaining = await readIncrementalTranscriptMessages(
      filePath,
      state,
      decode,
      (messages) => {
        if (!closed) {
          onAppend(messages)
        }
      }
    )
    if (!closed && remaining.length > 0) {
      onAppend(remaining)
    }
  }

  async function drainOnce(): Promise<void> {
    const current = await fileVersion(filePath)
    const currentBoundary = await boundaryFingerprint(filePath, state.offset)
    if (closed) {
      return
    }
    if (watcherNeedsRebind) {
      bindWatcher()
    }
    const identityChanged = watchedIdentity !== null && current.identity !== watchedIdentity
    const contentReplaced =
      identityChanged ||
      current.size < state.offset ||
      (state.offset > 0 && watchedBoundary !== currentBoundary)
    if (contentReplaced) {
      resetIncrementalTranscriptState(state)
    }
    watchedIdentity = current.identity

    const replacementSnapshot =
      // Why: 0 is a valid window — an explicit undefined check keeps an empty
      // snapshot empty instead of falling back to an unbounded incremental read.
      contentReplaced && !initialDrain && onReplace && initialLimit !== undefined
        ? await readNativeChatTranscriptTailFile(filePath, initialLimit, decode)
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
        replacementSnapshot.beforeOffset
      )
      await readAndEmitAppends()
      watchedBoundary = await boundaryFingerprint(filePath, state.offset)
      rotationRetryCount = 0
      return
    }

    const initialSnapshot =
      initialDrain && onInitialSnapshot && initialLimit !== undefined
        ? await readNativeChatTranscriptTailFile(filePath, initialLimit, decode)
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
          initialSnapshot.beforeOffset
        )
        await readAndEmitAppends()
      } else {
        const messages = await readIncrementalTranscriptMessages(filePath, state, decode)
        onInitialSnapshot(messages, false, 0)
      }
    } else {
      initialDrain = false
      await readAndEmitAppends()
    }
    watchedBoundary = await boundaryFingerprint(filePath, state.offset)
    rotationRetryCount = 0
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
          if (initialDrain && onInitialSnapshot && !initialErrorEmitted) {
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

  function bindWatcher(): void {
    const watchedName = basename(filePath)
    // Why: file watchers stay bound to an unlinked inode on macOS. Watching
    // the parent keeps observing a successor even after a long recreate gap.
    const nextWatcher = watch(dirname(filePath), (_event, changedName) => {
      if (changedName === null || changedName.toString() === watchedName) {
        scheduleDrain()
      }
    })
    nextWatcher.on('error', () => {
      // Why: Windows can emit EPERM when a watched directory disappears. An
      // error listener prevents a process crash and retries against its successor.
      if (closed || watcher !== nextWatcher) {
        return
      }
      watcherNeedsRebind = true
      nextWatcher.close()
      watcher = null
      scheduleRotationRetry()
    })
    watcher = nextWatcher
    watcherNeedsRebind = false
  }

  try {
    bindWatcher()
  } catch {
    // File vanished between resolve and watch.
    return null
  }
  activeWatcherCount++
  scheduleDrain()

  return {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      watcher?.close()
      watcher = null
      activeWatcherCount--
    }
  }
}
