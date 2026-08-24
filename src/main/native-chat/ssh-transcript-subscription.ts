import { onSshFilesystemProviderChanged } from '../providers/ssh-filesystem-dispatch'
import type { NativeChatTranscriptOwner } from './native-chat-transcript-owner'
import { createSshTranscriptRangeFs } from './ssh-transcript-range-fs'
import {
  isTranscriptHostUnverifiableError,
  TRANSCRIPT_UNVERIFIABLE_MESSAGE
} from './transcript-host-verdict'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import { installTranscriptWatcher } from './transcript-watch-engine'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 5_000
type SshOwner = Extract<NativeChatTranscriptOwner, { kind: 'ssh' }>

export function subscribeSshNativeChatTranscript(
  owner: SshOwner,
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): NativeChatTranscriptSubscription {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode || setupSignal?.aborted) {
    return { unsubscribe: () => {}, watching: false }
  }
  if (!owner.transcriptPath) {
    try {
      args.onInitialSnapshot?.([], false, 0, 'Transcript unavailable')
    } catch {
      // The server-owned locator will rebind if the hook later reports a path.
    }
    return { unsubscribe: () => {}, watching: true }
  }
  const transcriptPath = owner.transcriptPath
  const lineDecoder = decode
  let closed = false
  let installed: NativeChatTranscriptSubscription | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = args.resolvePollIntervalMs ?? INITIAL_RETRY_MS
  let attemptVersion = 0
  let attemptController: AbortController | null = null
  let attemptInFlight = false
  let rerunRequested = false
  let unverifiableEmitted = false

  const stopProviderChanges = onSshFilesystemProviderChanged((connectionId) => {
    if (connectionId !== owner.connectionId || closed) {
      return
    }
    attemptVersion++
    attemptController?.abort()
    installed?.unsubscribe()
    installed = null
    clearRetry()
    void runAttempt()
  })

  const abortFromSetup = (): void => subscription.unsubscribe()
  setupSignal?.addEventListener('abort', abortFromSetup, { once: true })

  function clearRetry(): void {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function emitUnverifiable(): void {
    if (unverifiableEmitted || !args.onInitialSnapshot) {
      return
    }
    unverifiableEmitted = true
    try {
      args.onInitialSnapshot([], false, 0, TRANSCRIPT_UNVERIFIABLE_MESSAGE)
    } catch {
      // The advisory cannot own retry liveness when its subscriber is closing.
    }
  }

  function scheduleRetry(): void {
    if (closed || installed || retryTimer) {
      return
    }
    retryTimer = setTimeout(() => {
      retryTimer = null
      void runAttempt()
    }, retryMs)
    retryTimer.unref?.()
    if (args.resolvePollIntervalMs === undefined) {
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    }
  }

  async function runAttempt(): Promise<void> {
    if (closed || installed) {
      return
    }
    if (attemptInFlight) {
      rerunRequested = true
      return
    }
    attemptInFlight = true
    const version = attemptVersion
    const controller = new AbortController()
    attemptController = controller
    try {
      const rangeFs = await createSshTranscriptRangeFs(owner.connectionId, controller.signal)
      const result = await installTranscriptWatcher(
        transcriptPath,
        lineDecoder,
        {
          ...args,
          filePath: transcriptPath,
          transcriptPath,
          rangeFs
        },
        controller.signal
      )
      if (closed || controller.signal.aborted || version !== attemptVersion) {
        result?.unsubscribe()
        return
      }
      unverifiableEmitted = false
      if (result) {
        installed = result
        retryMs = args.resolvePollIntervalMs ?? INITIAL_RETRY_MS
        return
      }
      scheduleRetry()
    } catch (error) {
      if (!closed && !controller.signal.aborted) {
        if (isTranscriptHostUnverifiableError(error)) {
          emitUnverifiable()
        }
        scheduleRetry()
      }
    } finally {
      if (attemptController === controller) {
        attemptController = null
      }
      attemptInFlight = false
      if (rerunRequested && !closed && !installed) {
        rerunRequested = false
        void runAttempt()
      }
    }
  }

  const subscription: NativeChatTranscriptSubscription = {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      attemptVersion++
      attemptController?.abort()
      setupSignal?.removeEventListener('abort', abortFromSetup)
      stopProviderChanges()
      clearRetry()
      installed?.unsubscribe()
      installed = null
    }
  }
  if (setupSignal?.aborted) {
    subscription.unsubscribe()
  }
  void runAttempt()
  return subscription
}
