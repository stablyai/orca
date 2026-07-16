import type { ChildProcess } from 'node:child_process'
import { removeWatcherCanaryDirectory } from './parcel-watcher-canary-directory'
import type { WatcherCancellationTracker } from './parcel-watcher-cancellation-tracker'
import {
  type PendingWatcherUnsubscribe,
  resolvePendingWatcherUnsubscribes
} from './parcel-watcher-host-subscriptions'
import {
  resetPendingSubscribeAttempt,
  takePendingSubscribe
} from './parcel-watcher-pending-subscribe'
import { watcherHostFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

export function disposeWatcherSupervisor(
  child: ChildProcess | null,
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  cancelledSubscribes: WatcherCancellationTracker,
  canaryDir: string | null
): null {
  const error = watcherHostFailure('file watcher supervisor disposed', 'supervisor_disposed')
  for (const record of records.values()) {
    resetPendingSubscribeAttempt(record)
    takePendingSubscribe(record)?.reject(error)
  }
  resolvePendingWatcherUnsubscribes(pendingUnsubscribes)
  cancelledSubscribes.completeAll()
  records.clear()
  child?.kill()
  return removeWatcherCanaryDirectory(canaryDir)
}
