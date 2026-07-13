export type WatcherProcessFailureScope = 'subscription' | 'supervisor'

export type WatcherProcessFailureCode =
  | 'entry_missing'
  | 'process_unavailable'
  | 'subscribe_aborted'
  | 'subscribe_failed'
  | 'subscribe_timeout'
  | 'supervisor_crash_fuse'
  | 'supervisor_disposed'

export class WatcherProcessFailure extends Error {
  constructor(
    message: string,
    readonly scope: WatcherProcessFailureScope,
    readonly code: WatcherProcessFailureCode
  ) {
    super(message)
    this.name = 'WatcherProcessFailure'
  }
}

export function watcherHostFailure(
  message: string,
  code: WatcherProcessFailureCode
): WatcherProcessFailure {
  return new WatcherProcessFailure(message, 'supervisor', code)
}

export function isWatcherProcessFailure(error: unknown): error is WatcherProcessFailure {
  return error instanceof WatcherProcessFailure
}
