import type { ChildProcess } from 'node:child_process'
import {
  resetPendingSubscribeAttempt,
  takePendingSubscribe
} from './parcel-watcher-pending-subscribe'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { HostToWatcherMessage, WatcherToHostMessage } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessSubscription,
  WatcherProcessSubscriptionRecord
} from './parcel-watcher-process-subscription'

export function handleWatcherHostMessage(
  message: Exclude<
    WatcherToHostMessage,
    { op: 'subscribe-started' } | { op: 'cancel-requires-restart' }
  >,
  records: Map<number, WatcherProcessSubscriptionRecord>,
  pendingUnsubscribes: Map<number, () => void>,
  reportTerminalError: (record: WatcherProcessSubscriptionRecord, error: Error) => void,
  killWatcherChildIfIdle: () => void
): void {
  if (message.op === 'unsubscribed') {
    const resolve = pendingUnsubscribes.get(message.id)
    pendingUnsubscribes.delete(message.id)
    resolve?.()
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
  pendingUnsubscribes: Map<number, () => void>
): void {
  for (const resolve of pendingUnsubscribes.values()) {
    resolve()
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
  pendingUnsubscribes: Map<number, () => void>
  getChild: () => ChildProcess | null
  killWatcherChildIfIdle: () => void
  sendToChild: (child: ChildProcess, message: HostToWatcherMessage) => void
}

export function createHostWatcherSubscription({
  record,
  records,
  pendingUnsubscribes,
  getChild,
  killWatcherChildIfIdle,
  sendToChild
}: CreateHostWatcherSubscriptionOptions): WatcherProcessSubscription {
  return {
    unsubscribe: (): Promise<void> => {
      if (!records.delete(record.id)) {
        return Promise.resolve()
      }
      resetPendingSubscribeAttempt(record)
      const child = getChild()
      if (!child?.connected) {
        return Promise.resolve()
      }
      if (records.size === 0) {
        killWatcherChildIfIdle()
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        pendingUnsubscribes.set(record.id, resolve)
        sendToChild(child, { op: 'unsubscribe', id: record.id })
      })
    }
  }
}
