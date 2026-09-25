import type { OrcaRuntimeService } from '../../../orca-runtime'

type RegistrationRuntime = Pick<
  OrcaRuntimeService,
  | 'registerOwnedSubscriptionCleanup'
  | 'subscribeToPtyExit'
  | 'handleMobileSubscribe'
  | 'handleMobileUnsubscribe'
>

/** One `terminal.subscribe` request, addressable from admission until it is released. */
export type TerminalSubscriptionRegistration = {
  readonly released: boolean
  /** Aborted once release has torn everything down. */
  readonly signal: AbortSignal
  /** Runs the stream's teardown on release, or now if the registration was already released. */
  setTeardown(teardown: () => void): void
  releaseOnPtyExit(ptyId: string): void
  addMobilePresence(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number } | undefined
  ): Promise<void>
  /** Releases and ends the stream. */
  release(): void
  /** Releases without `end`, for a handler about to fail the request instead. */
  releaseSilently(): void
}

export function registerTerminalSubscription({
  runtime,
  subscriptionId,
  connectionId,
  requestSignal,
  emit
}: {
  runtime: RegistrationRuntime
  subscriptionId: string
  connectionId: string | undefined
  requestSignal: AbortSignal | undefined
  emit: (result: unknown) => void
}): TerminalSubscriptionRegistration {
  const controller = new AbortController()
  let released = false
  let ended = false
  let teardown: (() => void) | null = null
  let stopWatchingExit = (): void => {}
  let presence: { ptyId: string; clientId: string } | null = null

  const end = (): void => {
    if (ended) {
      return
    }
    ended = true
    emit({ type: 'end' })
  }
  const releaseOnce = (): void => {
    // Why: the registry calls cleanup before recording it as in flight, so a re-entrant release must be a no-op.
    if (released) {
      return
    }
    released = true
    requestSignal?.removeEventListener('abort', onRequestAbort)
    try {
      try {
        stopWatchingExit()
        teardown?.()
      } finally {
        // Why: the latch makes any retry a no-op, so a throwing teardown must not strand phone presence.
        if (presence) {
          runtime.handleMobileUnsubscribe(presence.ptyId, presence.clientId)
        }
      }
    } finally {
      controller.abort()
    }
  }
  // Why: a closed socket hands out a pre-aborted signal; registering would evict the slot's live stream for a dead request.
  const registryEntry = requestSignal?.aborted
    ? null
    : runtime.registerOwnedSubscriptionCleanup(
        subscriptionId,
        () => {
          try {
            releaseOnce()
          } finally {
            end()
          }
        },
        connectionId
      )
  // Why: route through the registry so the entry leaves with the release and a teardown error is contained there.
  const release = (): void => registryEntry?.releaseIfCurrent()
  const onRequestAbort = (): void => release()

  const registration: TerminalSubscriptionRegistration = {
    get released() {
      return released
    },
    signal: controller.signal,
    setTeardown(nextTeardown) {
      if (released) {
        nextTeardown()
        return
      }
      teardown = nextTeardown
    },
    releaseOnPtyExit(ptyId) {
      const unsubscribe = runtime.subscribeToPtyExit(ptyId, release)
      if (released) {
        // Why: an already-exited pty releases synchronously, before the unsubscribe exists to stop.
        unsubscribe()
        return
      }
      stopWatchingExit = unsubscribe
    },
    async addMobilePresence(ptyId, clientId, viewport) {
      if (released) {
        return
      }
      // Why: presence and the driver are set before the layout await, so a release during it must remove them.
      presence = { ptyId, clientId }
      await runtime.handleMobileSubscribe(ptyId, clientId, viewport)
    },
    release,
    releaseSilently() {
      ended = true
      release()
    }
  }
  if (registryEntry) {
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
  } else {
    releaseOnce()
  }
  return registration
}
