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
  requestId,
  requestSignal,
  emit
}: {
  runtime: RegistrationRuntime
  subscriptionId: string
  connectionId: string | undefined
  /** With `connectionId`, lets `terminal.unsubscribe{requestId}` address this exact request. */
  requestId: string | undefined
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
    // Registry records in-flight cleanup after calling it; latch first against reentrant release.
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
        // The latch prevents retries, so teardown failure must still release presence.
        if (presence) {
          runtime.handleMobileUnsubscribe(presence.ptyId, presence.clientId)
        }
      }
    } finally {
      controller.abort()
    }
  }
  // Dead sockets provide pre-aborted signals; do not evict a live slot for one.
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
        connectionId,
        requestId
      )
  // Registry release removes the entry and contains teardown errors.
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
        // An already-exited PTY releases synchronously before unsubscribe is available.
        unsubscribe()
        return
      }
      stopWatchingExit = unsubscribe
    },
    async addMobilePresence(ptyId, clientId, viewport) {
      if (released) {
        return
      }
      // Release during layout await must undo presence/driver registered before it.
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
