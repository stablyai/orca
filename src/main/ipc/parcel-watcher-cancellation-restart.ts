import type { ChildProcess } from 'node:child_process'
import {
  failAllWatcherSubscriptions,
  type PendingWatcherUnsubscribe,
  resolvePendingWatcherUnsubscribes
} from './parcel-watcher-host-subscriptions'
import type { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import {
  createWatcherChildTerminationFailure,
  terminateWatcherChild
} from './parcel-watcher-child-termination'
import { resetPendingSubscribeAttempt } from './parcel-watcher-pending-subscribe'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

export function restoreWatcherRecordsAfterCancellation(
  records: Map<number, WatcherProcessSubscriptionRecord>,
  ensureWatcherProcess: () => ChildProcess | null,
  sendSubscribe: (child: ChildProcess, record: WatcherProcessSubscriptionRecord) => void,
  onUnavailable: () => void
): void {
  if (records.size === 0) {
    return
  }
  const replacement = ensureWatcherProcess()
  if (!replacement) {
    failAllWatcherSubscriptions(
      records,
      new WatcherProcessFailure(
        'file watcher process unavailable after subscription cancellation',
        'supervisor',
        'process_unavailable'
      )
    )
    onUnavailable()
    return
  }
  for (const record of records.values()) {
    record.interrupted = true
    resetPendingSubscribeAttempt(record)
    sendSubscribe(replacement, record)
  }
}

export function failWatcherRecordsAfterTerminationDeadline(
  records: Map<number, WatcherProcessSubscriptionRecord>,
  error = new WatcherProcessFailure(
    'file watcher process did not exit after termination deadline',
    'supervisor',
    'process_unavailable'
  )
): void {
  failAllWatcherSubscriptions(records, error)
}

export async function restartCancelledWatcherChild(
  child: ChildProcess,
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  cancelledSubscribes: WatcherCancellationTracker,
  onTerminationFinished: (exited: boolean) => boolean,
  ensureWatcherProcess: () => ChildProcess | null,
  sendSubscribe: (child: ChildProcess, record: WatcherProcessSubscriptionRecord) => void,
  onUnavailable: () => void
): Promise<void> {
  const exited = await terminateWatcherChild(child)
  const shouldRestore = onTerminationFinished(exited)
  if (!exited) {
    const error = createWatcherChildTerminationFailure(child)
    cancelledSubscribes.finishRestart(child, error)
    resolvePendingWatcherUnsubscribes(pendingUnsubscribes, error)
    failWatcherRecordsAfterTerminationDeadline(records, error)
    throw error
  }
  cancelledSubscribes.finishRestart(child)
  resolvePendingWatcherUnsubscribes(pendingUnsubscribes)
  if (!shouldRestore) {
    return
  }
  restoreWatcherRecordsAfterCancellation(
    records,
    ensureWatcherProcess,
    sendSubscribe,
    onUnavailable
  )
}
