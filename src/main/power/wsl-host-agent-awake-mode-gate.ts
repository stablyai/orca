import type { ComputerAwakeStatus } from '../../shared/app-lifecycle/computer-awake-mode'

type AwakeModeSource = {
  getStatus: () => ComputerAwakeStatus
  subscribe: (listener: (status: ComputerAwakeStatus) => void) => () => void
}

// Why: only Auto reads WSL counts; Off/On would hold an inventory stream per host for nothing.
export function runWslHostAgentAwakeWhileAuto(
  source: AwakeModeSource,
  createWatcher: () => { dispose: () => void }
): () => void {
  let watcher: { dispose: () => void } | null = null
  const sync = (status: ComputerAwakeStatus): void => {
    if (status.mode === 'auto') {
      watcher ??= createWatcher()
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
