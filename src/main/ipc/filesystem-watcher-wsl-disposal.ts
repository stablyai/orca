import type { WslWatchEngine } from './filesystem-watcher-wsl-engine'

export function clearWslWatcherTimers(
  timers: readonly (ReturnType<typeof setTimeout> | null)[]
): void {
  for (const timer of timers) {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function stopWslWatcherEngines(
  startingEngines: Set<WslWatchEngine>,
  activeEngine: WslWatchEngine | null
): void {
  for (const engine of startingEngines) {
    engine.stop()
  }
  startingEngines.clear()
  activeEngine?.stop()
}
