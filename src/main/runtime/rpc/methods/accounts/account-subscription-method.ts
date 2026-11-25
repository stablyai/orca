import { defineStreamingMethod } from '../../core'
import type { AccountsSnapshot } from '../../../agent-session/environment/runtime-account-controller'

// Same-millisecond subscriptions must not evict each other's cleanup.
let accountsSubscriptionSeq = 0

// Stream rate-limit polls and account switches to mobile without reopening the screen.
export const ACCOUNT_SUBSCRIPTION_METHOD = defineStreamingMethod({
  name: 'accounts.subscribe',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async (_params, { runtime, connectionId, signal, caller }, emit) => {
    if (signal?.aborted) {
      return
    }
    const stopped = Promise.withResolvers<void>()
    let active = true
    let ready = false
    let latest: AccountsSnapshot | undefined
    const unsubscribe = runtime.onAccountsChanged((snapshot) => {
      if (ready) {
        emit({ type: 'snapshot', snapshot })
      } else {
        latest = snapshot
      }
    })
    // A paired client watching keeps polls running without a window; the host's own renderer follows window focus.
    const releaseUsageViewer =
      caller?.kind === 'paired-device' ? runtime.getUsageRateLimits()?.addUsageViewer() : undefined

    // Key cleanup by socket plus sequence so sibling sockets and concurrent subscribes cannot evict each other.
    const seq = ++accountsSubscriptionSeq
    const subscriptionId = `accounts-${connectionId ?? 'inproc'}-${seq}`
    const release = (): void => runtime.cleanupSubscription(subscriptionId)
    runtime.registerSubscriptionCleanup(
      subscriptionId,
      () => {
        active = false
        signal?.removeEventListener('abort', release)
        unsubscribe()
        releaseUsageViewer?.()
        stopped.resolve()
      },
      connectionId
    )

    try {
      if (signal?.aborted) {
        release()
      } else {
        signal?.addEventListener('abort', release, { once: true })
        // Publish a snapshot immediately, then refresh stale data; reconnect must not force repeated provider fetches.
        const snapshot = await runtime.getAccountsStreamSnapshot()
        if (active && !signal?.aborted) {
          emit({ type: 'ready', subscriptionId, snapshot: latest ?? snapshot })
          ready = true
          void runtime.refreshAccountsForMobileSubscriber()
        }
      }
      await stopped.promise
      emit({ type: 'end' })
    } finally {
      release()
    }
  }
})
