import { resetPendingSubscribeAttempt } from './parcel-watcher-pending-subscribe'
import type { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessSubscriptionRecord } from './parcel-watcher-process-subscription'

export function cancelInterruptedWatcherSubscribe(args: {
  record: WatcherProcessSubscriptionRecord
  error: WatcherProcessFailure
  records: Map<number, WatcherProcessSubscriptionRecord>
  reportTerminalError: (record: WatcherProcessSubscriptionRecord, error: Error) => void
  restartChild: () => Promise<void>
}): void {
  const { record } = args
  if (!record.interrupted || record.pendingSubscribe || !args.records.delete(record.id)) {
    return
  }
  resetPendingSubscribeAttempt(record)
  // Why: recovery may replace this root synchronously from the terminal hook;
  // publish failure only after its predecessor releases native handles.
  void args.restartChild().then(
    () => args.reportTerminalError(record, args.error),
    (terminationError: unknown) =>
      args.reportTerminalError(
        record,
        terminationError instanceof Error ? terminationError : new Error(String(terminationError))
      )
  )
}
