import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OrcadDelegatedExitEvent } from './orcad-delegated-exit-delivery'

type Listener = Parameters<IPtyProvider['onExit']>[0]
type Exit = Parameters<Listener>[0]

/** Observes runtime-accepted exits; never feeds provider output back into the model. */
export class OrcadDelegatedProviderExits {
  private readonly listeners = new Set<Listener>()
  private exit: Readonly<Exit> | undefined
  private disposed = false

  constructor(
    private readonly options: {
      onExit?: (event: OrcadDelegatedExitEvent) => void
      onError: (error: unknown) => void
      isActive: () => boolean
    }
  ) {}

  onExit: IPtyProvider['onExit'] = (listener) => {
    if (this.disposed || !this.options.isActive()) {
      return () => {}
    }
    if (this.exit) {
      this.notify(listener, this.exit)
      return () => {}
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  accept = (event: OrcadDelegatedExitEvent): void => {
    if (this.disposed || !this.options.isActive() || this.exit) {
      return
    }
    // Runtime rejection must leave delivery retryable and invisible to provider consumers.
    this.options.onExit?.(event)
    if (this.disposed || !this.options.isActive()) {
      return
    }
    this.exit = Object.freeze({
      id: event.identity.terminalId,
      incarnationId: event.identity.incarnationId,
      code: event.exit.code ?? -1
    })
    for (const listener of this.listeners) {
      if (this.disposed || !this.options.isActive()) {
        break
      }
      this.notify(listener, this.exit)
    }
    this.listeners.clear()
  }

  dispose = (): void => {
    this.disposed = true
    this.listeners.clear()
    this.exit = undefined
  }

  private notify(listener: Listener, exit: Readonly<Exit>): void {
    try {
      listener(exit)
    } catch (error) {
      try {
        this.options.onError(error)
      } catch {
        /* Observers cannot undo an accepted exit. */
      }
    }
  }
}
