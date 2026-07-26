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
import type { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

export function recoverWatcherRecordsAfterChildGone(
  records: Map<number, WatcherProcessSubscriptionRecord>,
  crashFuse: WatcherProcessCrashFuse,
  shutdownRequested: boolean,
  ensureWatcherProcess: () => ChildProcess | null,
  sendSubscribe: (child: ChildProcess, record: WatcherProcessSubscriptionRecord) => void,
  removeCanary: () => void,
  code?: number | null,
  signal?: NodeJS.Signals | null
): void {
  if (code !== undefined && (code !== 0 || signal)) {
    console.error(
      `[parcel-watcher-process] watcher process exited (code=${code}, signal=${signal})`
    )
  }
  if (shutdownRequested || records.size === 0) {
    return
  }
  crashFuse.recordCrash()
  for (const record of records.values()) {
    record.interrupted = true
    resetPendingSubscribeAttempt(record)
  }
  const replacement = ensureWatcherProcess()
  if (!replacement) {
    console.error(
      '[parcel-watcher-process] watcher process crashed repeatedly; disabling file watching'
    )
    failAllWatcherSubscriptions(
      records,
      new WatcherProcessFailure(
        'file watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      )
    )
    removeCanary()
    return
  }
  console.error(
    `[parcel-watcher-process] watcher process crashed; resubscribing ${records.size} root(s)`
  )
  for (const record of records.values()) {
    sendSubscribe(replacement, record)
  }
}

export async function terminateDisconnectedWatcherChild(
  child: ChildProcess,
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  cancelledSubscribes: WatcherCancellationTracker,
  crashFuse: WatcherProcessCrashFuse,
  onTerminationFinished: (exited: boolean) => boolean,
  ensureWatcherProcess: () => ChildProcess | null,
  sendSubscribe: (child: ChildProcess, record: WatcherProcessSubscriptionRecord) => void,
  removeCanary: () => void
): Promise<void> {
  const exited = await terminateWatcherChild(child)
  const error = exited ? undefined : createWatcherChildTerminationFailure(child)
  cancelledSubscribes.completeForChild(child, error)
  const shouldRestore = onTerminationFinished(exited)
  resolvePendingWatcherUnsubscribes(pendingUnsubscribes, error)
  if (error) {
    failAllWatcherSubscriptions(records, error)
    throw error
  }
  if (shouldRestore) {
    recoverWatcherRecordsAfterChildGone(
      records,
      crashFuse,
      false,
      ensureWatcherProcess,
      sendSubscribe,
      removeCanary
    )
  }
}
