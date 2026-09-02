import type { ChildProcess } from 'node:child_process'
import type { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import { takePendingSubscribe } from './parcel-watcher-pending-subscribe'
import type { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

type CancelPendingWatcherSubscribeOptions = {
  record: WatcherProcessSubscriptionRecord
  error: WatcherProcessFailure
  records: Map<number, WatcherProcessSubscriptionRecord>
  child: ChildProcess | null
  cancelledSubscribes: WatcherCancellationTracker
  onChildUnavailable: (child: ChildProcess | null) => Promise<void>
  restartChild: (child: ChildProcess) => Promise<void>
  sendCancel: (child: ChildProcess, id: number) => void
}

export function cancelPendingWatcherSubscribe({
  record,
  error,
  records,
  child,
  cancelledSubscribes,
  onChildUnavailable,
  restartChild,
  sendCancel
}: CancelPendingWatcherSubscribeOptions): void {
  if (!record.pendingSubscribe || !records.delete(record.id)) {
    return
  }
  const pending = takePendingSubscribe(record)
  if (!pending) {
    return
  }
  if (!child?.connected) {
    // Why: disconnect starts physical termination before cancellation sees the
    // child; destructive callers must join that exact termination generation.
    void onChildUnavailable(child).then(
      () => pending.reject(error),
      (terminationError: unknown) =>
        pending.reject(
          terminationError instanceof Error ? terminationError : new Error(String(terminationError))
        )
    )
    return
  }
  // Why: only the child knows whether native setup is queued, active, or
  // resolved, so its physical teardown must precede caller settlement.
  cancelledSubscribes.begin(record.id, child, error, pending.reject, () => restartChild(child))
  sendCancel(child, record.id)
}
