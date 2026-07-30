export type RefreshTimerLifecycle = {
  disposed: boolean
  timers: ReturnType<typeof setTimeout>[]
}

export function addRefreshTimer(
  lifecycle: RefreshTimerLifecycle,
  delayMs: number,
  callback: () => void
): void {
  if (!lifecycle.disposed) {
    lifecycle.timers.push(setTimeout(callback, delayMs))
  }
}
