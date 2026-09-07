import type { RuntimeTerminalCreate } from '../../shared/runtime-types'

const DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES = 4_096

export class RemoteRuntimeTerminalCreateIdempotency {
  private readonly inFlight = new Map<string, Promise<RuntimeTerminalCreate>>()

  constructor(private readonly maxInFlight = DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES) {}

  run(
    clientIdentity: string,
    worktreeId: string,
    clientMutationId: string,
    create: () => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    const key = `${clientIdentity}\0${worktreeId}\0${clientMutationId}`
    const existing = this.inFlight.get(key)
    if (existing) {
      return existing
    }
    if (this.inFlight.size >= this.maxInFlight) {
      return Promise.reject(
        new Error('Too many terminal creations are still pending; retry after they settle.')
      )
    }

    const promise = create()
    this.inFlight.set(key, promise)
    const drop = (): void => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key)
      }
    }
    void promise.then(drop, drop)
    return promise
  }
}
