import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  PendingWatcherProcessSubscribe,
  WatcherProcessSubscriptionRecord
} from './parcel-watcher-process-subscription'

export function installPendingSubscribeControls(
  record: WatcherProcessSubscriptionRecord,
  cancel: (error: WatcherProcessFailure) => void
): void {
  const pending = record.pendingSubscribe
  if (!pending) {
    return
  }
  if (record.hooks.signal) {
    pending.abortListener = () =>
      cancel(
        new WatcherProcessFailure(
          'file watcher subscription aborted',
          'subscription',
          'subscribe_aborted'
        )
      )
    record.hooks.signal.addEventListener('abort', pending.abortListener, { once: true })
  }
}

export function startPendingSubscribeTimeout(
  record: WatcherProcessSubscriptionRecord,
  cancel: (error: WatcherProcessFailure) => void
): void {
  const pending = record.pendingSubscribe
  if (!pending) {
    return
  }
  record.crawlStarted = true
  if (pending.timer || record.hooks.subscribeTimeoutMs === undefined) {
    return
  }
  pending.timer = setTimeout(() => {
    cancel(
      new WatcherProcessFailure(
        `file watcher subscription timed out after ${record.hooks.subscribeTimeoutMs}ms`,
        'subscription',
        'subscribe_timeout'
      )
    )
  }, record.hooks.subscribeTimeoutMs)
  pending.timer.unref?.()
}

export function startInterruptedSubscribeTimeout(
  record: WatcherProcessSubscriptionRecord,
  cancel: (error: WatcherProcessFailure) => void
): void {
  if (
    !record.interrupted ||
    record.pendingSubscribe ||
    record.resubscribeTimer ||
    record.hooks.subscribeTimeoutMs === undefined
  ) {
    return
  }
  record.crawlStarted = true
  record.resubscribeTimer = setTimeout(() => {
    cancel(
      new WatcherProcessFailure(
        `file watcher resubscription timed out after ${record.hooks.subscribeTimeoutMs}ms`,
        'subscription',
        'subscribe_timeout'
      )
    )
  }, record.hooks.subscribeTimeoutMs)
  record.resubscribeTimer.unref?.()
}

export function resetPendingSubscribeAttempt(record: WatcherProcessSubscriptionRecord): void {
  record.crawlStarted = false
  if (record.resubscribeTimer) {
    clearTimeout(record.resubscribeTimer)
    record.resubscribeTimer = undefined
  }
  const pending = record.pendingSubscribe
  if (pending?.timer) {
    clearTimeout(pending.timer)
    pending.timer = undefined
  }
}

export function takePendingSubscribe(
  record: WatcherProcessSubscriptionRecord
): PendingWatcherProcessSubscribe | undefined {
  const pending = record.pendingSubscribe
  if (!pending) {
    return undefined
  }
  record.pendingSubscribe = undefined
  if (pending.abortListener && record.hooks.signal) {
    record.hooks.signal.removeEventListener('abort', pending.abortListener)
  }
  if (pending.timer) {
    clearTimeout(pending.timer)
  }
  return pending
}
