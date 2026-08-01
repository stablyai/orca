import type { RelayDispatcher } from './dispatcher'
import { emitRelayWatcherOverflow } from './relay-watcher-event-emitter'
import { emitRelayWatcherTerminalFailure } from './relay-watcher-terminal-notifier'
import type { RelayWatcherTeardownState } from './relay-watcher-teardown-tracker'
import { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import { startWatcherGenerationReplacement } from '../shared/watcher-generation-replacement'

type RelayWatcherRecoveryOptions = {
  state: RelayWatcherTeardownState
  failedGeneration: number
  error: Error
  releaseFailedSubscription: boolean
  dispatcher: RelayDispatcher
  install: (generation: number) => Promise<void>
  close: () => Promise<void>
}

export function recoverRelayWatcherGeneration(options: RelayWatcherRecoveryOptions): void {
  const { state } = options
  const replacement = startWatcherGenerationReplacement(
    state,
    options.failedGeneration,
    () => {
      const failedSubscription = options.releaseFailedSubscription ? state.subscription : null
      state.subscription = null
      emitRelayWatcherOverflow(options.dispatcher, state.rootPath, state.closed)
      return failedSubscription ? () => failedSubscription.unsubscribe() : undefined
    },
    options.install
  )
  if (!replacement) {
    return
  }
  state.setupWaiters = new PromiseSettlementWaiters(replacement.promise)
  void replacement.promise.catch((recoveryError: unknown) => {
    if (state.closed || state.generation !== replacement.generation) {
      return
    }
    const message = recoveryError instanceof Error ? recoveryError.message : options.error.message
    process.stderr.write(
      `[relay] File watcher disabled after bounded recovery for ${state.rootPath}: ${message}\n`
    )
    emitRelayWatcherTerminalFailure(options.dispatcher, state, message)
    void options.close().catch(() => {})
  })
}
