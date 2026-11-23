export type BackgroundWorkerApi = {
  onPaused: (callback: () => void) => () => void
  onResumed: (callback: () => void) => () => void
  /** A window that opens or reloads while paused still needs the notice. */
  isPaused: () => Promise<boolean>
  retry: () => Promise<void>
}
