import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { RemoteOpenCodeRuntimeOutcome } from './ssh-relay-opencode-runtime'

export type RemoteOpenCodeRuntimePreparation = (signal: AbortSignal) => Promise<void>

export function createRemoteOpenCodeRuntimeRetry(
  initialSetup: Promise<RemoteOpenCodeRuntimeOutcome>,
  backgroundCleanup: Promise<boolean>,
  retry: (signal: AbortSignal) => Promise<RemoteOpenCodeRuntimeOutcome>
): RemoteOpenCodeRuntimePreparation {
  let nextAttempt = Infinity
  let pending: Promise<void> | undefined
  const remember = (outcome: RemoteOpenCodeRuntimeOutcome): void => {
    nextAttempt =
      outcome === 'ready' || outcome === 'teardown-unconfirmed'
        ? Infinity
        : Date.now() + (outcome === 'not-needed' ? 60_000 : 30_000)
  }
  const initialized = initialSetup.then(remember).catch(() => {})
  return (signal) => {
    if (signal.aborted) {
      return Promise.resolve()
    }
    pending ??= (async () => {
      await waitForPromiseWithSignal(initialized, signal)
      if (Date.now() < nextAttempt) {
        return
      }
      if (!(await waitForPromiseWithSignal(backgroundCleanup, signal))) {
        nextAttempt = Infinity
        return
      }
      signal.throwIfAborted()
      remember(await retry(signal))
    })()
      .catch(() => {})
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}
