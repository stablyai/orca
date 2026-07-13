export type WatcherProcessEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
  isDirectory?: boolean
}

export type WatcherProcessSubscribeOptions = {
  ignore?: string[]
  ignoreGlobs?: string[]
  backend?: string
}

export type WatcherProcessDeliveryOptions = {
  includeDirectoryMetadata?: boolean
  maxEventsPerBatch?: number
}

export type HostToWatcherMessage =
  | {
      op: 'subscribe'
      id: number
      dir: string
      opts: WatcherProcessSubscribeOptions
      delivery?: WatcherProcessDeliveryOptions
    }
  | { op: 'unsubscribe'; id: number }
  | { op: 'cancel-subscribe'; id: number }

export type WatcherToHostMessage =
  | { op: 'subscribe-started'; id: number }
  | { op: 'subscribed'; id: number }
  | { op: 'subscribe-failed'; id: number; message: string }
  | { op: 'events'; id: number; events: WatcherProcessEvent[] }
  | { op: 'overflow'; id: number }
  | { op: 'watch-error'; id: number; message: string }
  | { op: 'cancel-requires-restart'; id: number }
  | { op: 'unsubscribed'; id: number }
