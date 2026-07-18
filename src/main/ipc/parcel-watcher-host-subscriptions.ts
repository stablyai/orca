import type { ChildProcess } from 'node:child_process'
import {
  resetPendingSubscribeAttempt,
  takePendingSubscribe
} from './parcel-watcher-pending-subscribe'
import { isWatcherProcessFailure, WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { HostToWatcherMessage, WatcherToHostMessage } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessSubscription,
  WatcherProcessSubscriptionRecord
} from './parcel-watcher-process-subscription'
import { RUNTIME_FILE_WATCH_CANCEL_TIMEOUT_MS } from '../../shared/runtime-file-watch-limits'

export type PendingWatcherUnsubscribe = (error?: Error) => void

export const WATCHER_PROCESS_UNSUBSCRIBE_TIMEOUT_MS = RUNTIME_FILE_WATCH_CANCEL_TIMEOUT_MS

const terminalTeardownFailures = new WeakMap<WatcherProcessSubscriptionRecord, Error>()

export function handleWatcherHostMessage(
  message: Exclude<
    WatcherToHostMessage,
    { op: 'subscribe-started' } | { op: 'cancel-requires-restart' }
  >,
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  reportTerminalError: (record: WatcherProcessSubscriptionRecord, error: Error) => void,
  killWatcherChildIfIdle: () => void
): void {
  if (message.op === 'unsubscribed') {
    const settle = pendingUnsubscribes.get(message.id)
    pendingUnsubscribes.delete(message.id)
    settle?.()
    return
  }
  const record = records.get(message.id)
  if (!record) {
    return
  }
  if (message.op === 'subscribed') {
    resetPendingSubscribeAttempt(record)
    takePendingSubscribe(record)?.resolve()
    if (record.interrupted) {
      record.interrupted = false
      record.hooks.onInterruption?.()
    }
    return
  }
  if (message.op === 'subscribe-failed') {
    records.delete(message.id)
    resetPendingSubscribeAttempt(record)
    const pending = takePendingSubscribe(record)
    const error = new WatcherProcessFailure(message.message, 'subscription', 'subscribe_failed')
    if (pending) {
      pending.reject(error)
    } else {
      reportTerminalError(record, error)
    }
    killWatcherChildIfIdle()
    return
  }
  if (message.op === 'events') {
    record.callback(null, message.events)
    return
  }
  if (message.op === 'overflow') {
    record.hooks.onOverflow?.()
    return
  }
  record.callback(new Error(message.message), [])
}

export function reportWatcherTerminalError(
  record: WatcherProcessSubscriptionRecord,
  error: Error
): void {
  if (isWatcherProcessFailure(error) && error.physicalExit) {
    terminalTeardownFailures.set(record, error)
    const clearFailure = (): void => {
      if (terminalTeardownFailures.get(record) === error) {
        terminalTeardownFailures.delete(record)
      }
    }
    void error.physicalExit.then(clearFailure, clearFailure)
  }
  if (record.hooks.onTerminalError) {
    record.hooks.onTerminalError(error)
    return
  }
  record.callback(error, [])
}

export function failAllWatcherSubscriptions(
  records: Map<number, WatcherProcessSubscriptionRecord>,
  error: Error
): void {
  // Snapshot first: onTerminalError hooks can dispose the supervisor and clear `records`.
  for (const record of Array.from(records.values())) {
    resetPendingSubscribeAttempt(record)
    const pending = takePendingSubscribe(record)
    if (pending) {
      pending.reject(error)
    } else {
      reportWatcherTerminalError(record, error)
    }
  }
  records.clear()
}

export function resolvePendingWatcherUnsubscribes(
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  error?: Error
): void {
  for (const settle of pendingUnsubscribes.values()) {
    settle(error)
  }
  pendingUnsubscribes.clear()
}

export function disposeWatcherSupervisorSubscriptions(
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, () => void>,
  cancelledSubscribesAwaitingChild: Set<number>,
  error: Error
): void {
  for (const record of records.values()) {
    resetPendingSubscribeAttempt(record)
    takePendingSubscribe(record)?.reject(error)
  }
  resolvePendingWatcherUnsubscribes(pendingUnsubscribes)
  cancelledSubscribesAwaitingChild.clear()
  records.clear()
}

export type CreateHostWatcherSubscriptionOptions = {
  record: WatcherProcessSubscriptionRecord
  records: Map<number, WatcherProcessSubscriptionRecord>
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>
  getChild: () => ChildProcess | null
  getTerminationPromise: () => Promise<void> | null
  killWatcherChildIfIdle: () => Promise<void>
  terminateUnavailableChild: (child: ChildProcess | null) => Promise<void>
  sendToChild: (child: ChildProcess, message: HostToWatcherMessage) => void
}

export function createHostWatcherSubscription({
  record,
  records,
  pendingUnsubscribes,
  getChild,
  getTerminationPromise,
  killWatcherChildIfIdle,
  terminateUnavailableChild,
  sendToChild
}: CreateHostWatcherSubscriptionOptions): WatcherProcessSubscription {
  return {
    unsubscribe: (): Promise<void> => {
      const terminalFailure = terminalTeardownFailures.get(record)
      if (terminalFailure) {
        return Promise.reject(terminalFailure)
      }
      const termination = getTerminationPromise()
      if (!records.delete(record.id)) {
        return termination ?? Promise.resolve()
      }
      resetPendingSubscribeAttempt(record)
      if (termination) {
        return termination
      }
      if (records.size === 0) {
        return killWatcherChildIfIdle()
      }
      const child = getChild()
      if (!child?.connected) {
        return terminateUnavailableChild(child)
      }
      return new Promise((resolve, reject) => {
        const onTimeout = (): void => {
          if (pendingUnsubscribes.get(record.id) !== settle) {
            return
          }
          // Why: canary setup itself can fail, so native teardown needs an
          // independent host deadline that exits the child and releases handles.
          void terminateUnavailableChild(child).catch(() => undefined)
        }
        const timer = setTimeout(onTimeout, WATCHER_PROCESS_UNSUBSCRIBE_TIMEOUT_MS)
        timer.unref?.()
        const settle: PendingWatcherUnsubscribe = (error) => {
          clearTimeout(timer)
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }
        pendingUnsubscribes.set(record.id, settle)
        sendToChild(child, { op: 'unsubscribe', id: record.id })
      })
    }
  }
}
