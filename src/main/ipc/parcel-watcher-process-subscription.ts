import type {
  WatcherProcessDeliveryOptions,
  WatcherProcessEvent,
  WatcherProcessSubscribeOptions
} from './parcel-watcher-process-protocol'

export type WatcherProcessCallback = (err: Error | null, events: WatcherProcessEvent[]) => void
export type WatcherProcessSubscription = { unsubscribe(): Promise<void> }
export type WatcherProcessHooks = {
  delivery?: WatcherProcessDeliveryOptions
  onInterruption?: () => void
  onOverflow?: () => void
  onTerminalError?: (error: Error) => void
  signal?: AbortSignal
  subscribeTimeoutMs?: number
}

export type PendingWatcherProcessSubscribe = {
  resolve: () => void
  reject: (err: Error) => void
  abortListener?: () => void
  timer?: ReturnType<typeof setTimeout>
}

export type WatcherProcessSubscriptionRecord = {
  id: number
  dir: string
  opts: WatcherProcessSubscribeOptions
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  interrupted: boolean
  crawlStarted: boolean
  resubscribeTimer?: ReturnType<typeof setTimeout>
  pendingSubscribe?: PendingWatcherProcessSubscribe
}
