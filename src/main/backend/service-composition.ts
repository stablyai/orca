import { startOrcadEventLoopWatchdog } from '../orcad/orcad-event-loop-watchdog'

export type BackendServiceCleanup = (state: { failed: boolean }) => void | Promise<void>

/** A service keeps its ownership fence until all accepted work and writers have retired. */
export class BackendServiceLifetime {
  private readonly cleanups: BackendServiceCleanup[] = []
  private stopping?: Promise<void>

  constructor(private readonly release: () => void = () => {}) {}

  add(cleanup: BackendServiceCleanup): void {
    if (this.stopping) {
      throw new Error('backend_service_lifetime_stopping')
    }
    this.cleanups.push(cleanup)
  }

  stop(): Promise<void> {
    this.stopping ??= Promise.resolve().then(async () => {
      const errors: unknown[] = []
      for (const cleanup of this.cleanups.splice(0).toReversed()) {
        try {
          await cleanup({ failed: errors.length > 0 })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'backend_service_cleanup_failed')
      }
      this.release()
    })
    return this.stopping
  }
}

/** Both hosts enter service activation here without importing an inactive service set. */
export async function activateBackendServices<T>(options: {
  supervised: boolean
  registerCleanup: (cleanup: BackendServiceCleanup) => void
  activate: (registerCleanup: (cleanup: BackendServiceCleanup) => void) => Promise<T>
}): Promise<T> {
  const watchdog = startOrcadEventLoopWatchdog({ supervised: options.supervised })
  options.registerCleanup(() => watchdog?.stop())
  return options.activate(options.registerCleanup)
}
