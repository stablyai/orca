import type { ChildProcess } from 'node:child_process'
import type { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import {
  handleWatcherHostMessage,
  type PendingWatcherUnsubscribe,
  reportWatcherTerminalError
} from './parcel-watcher-host-subscriptions'
import {
  startInterruptedSubscribeTimeout,
  startPendingSubscribeTimeout
} from './parcel-watcher-pending-subscribe'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherToHostMessage } from './parcel-watcher-process-protocol'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

type WatcherSupervisorMessageContext = {
  records: Map<number, WatcherProcessSubscriptionRecord>
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>
  cancelledSubscribes: WatcherCancellationTracker
  child: ChildProcess | null
  cancelPendingSubscribe: (
    record: WatcherProcessSubscriptionRecord,
    error: WatcherProcessFailure
  ) => void
  cancelInterruptedSubscribe: (
    record: WatcherProcessSubscriptionRecord,
    error: WatcherProcessFailure
  ) => void
  restartAfterCancelledSubscribe: (child: ChildProcess | null) => void
  terminateUnavailableChild: (child: ChildProcess | null) => void
  killWatcherChildIfIdle: () => void
}

export function handleWatcherSupervisorMessage(
  message: WatcherToHostMessage,
  context: WatcherSupervisorMessageContext
): void {
  const record = context.records.get(message.id)
  if (message.op === 'subscribe-started') {
    if (record) {
      startPendingSubscribeTimeout(record, (error) => context.cancelPendingSubscribe(record, error))
      startInterruptedSubscribeTimeout(record, (error) =>
        context.cancelInterruptedSubscribe(record, error)
      )
    }
    return
  }
  if (message.op === 'watch-error' && record) {
    const error = new WatcherProcessFailure(message.message, 'subscription', 'subscribe_failed')
    if (record.pendingSubscribe) {
      // Why: an error before readiness means native setup failed. Cancel the
      // physical crawl so a later subscribed ack cannot expose a dead root.
      context.cancelPendingSubscribe(record, error)
      return
    }
    if (record.interrupted && record.crawlStarted) {
      // Why: crash recovery has no pending caller promise, but its replacement
      // crawl is equally unready and must not accept a later subscribed ack.
      context.cancelInterruptedSubscribe(record, error)
      return
    }
  }
  if (message.op === 'watch-error') {
    handleWatcherHostMessage(
      message,
      context.records,
      context.pendingUnsubscribes,
      reportWatcherTerminalError,
      context.killWatcherChildIfIdle
    )
    return
  }
  if (message.op === 'cancel-requires-restart') {
    if (context.cancelledSubscribes.has(message.id)) {
      context.restartAfterCancelledSubscribe(context.child)
    }
    return
  }
  if (message.op === 'unsubscribe-failed') {
    context.terminateUnavailableChild(context.child)
    return
  }
  if (message.op === 'unsubscribed') {
    const completedCancellation = context.cancelledSubscribes.complete(message.id)
    handleWatcherHostMessage(
      message,
      context.records,
      context.pendingUnsubscribes,
      reportWatcherTerminalError,
      context.killWatcherChildIfIdle
    )
    if (completedCancellation) {
      context.killWatcherChildIfIdle()
    }
    return
  }
  handleWatcherHostMessage(
    message,
    context.records,
    context.pendingUnsubscribes,
    reportWatcherTerminalError,
    context.killWatcherChildIfIdle
  )
}
