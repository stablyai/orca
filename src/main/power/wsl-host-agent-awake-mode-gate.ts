import type { ComputerAwakeStatus } from '../../shared/app-lifecycle/computer-awake-mode'

type AwakeModeSource = {
  getStatus: () => ComputerAwakeStatus
  subscribe: (listener: (status: ComputerAwakeStatus) => void) => () => void
}

/**
 * Runs the WSL-host watcher only while keep-awake is Auto, the one mode that reads WSL counts.
 * Why: Off and On never consult them, so watching would hold one inventory stream per host for nothing.
 * Each Auto session gets a fresh watcher: rows already working when it first sees a host stay
 * uncounted until fresh evidence, since nothing was observed while the mode was not Auto.
 */
export function runWslHostAgentAwakeWhileAuto(
  source: AwakeModeSource,
  createWatcher: () => { dispose: () => void }
): () => void {
  let watcher: { dispose: () => void } | null = null
  let starting = false
  const sync = (status: ComputerAwakeStatus): void => {
    if (status.mode === 'auto') {
      if (watcher || starting) {
        return
      }
      // Why: a watcher that reports while constructing re-enters here before it is assigned.
      starting = true
      try {
        watcher = createWatcher()
      } finally {
        starting = false
      }
    } else if (watcher) {
      const stopping = watcher
      watcher = null
      // Disposing reports every host empty, clearing its counts from the service.
      stopping.dispose()
    }
  }
  const unsubscribe = source.subscribe(sync)
  sync(source.getStatus())
  return () => {
    unsubscribe()
    const stopping = watcher
    watcher = null
    stopping?.dispose()
  }
}
