import { isDeepStrictEqual } from 'node:util'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { TerminalCreateOperationKind } from './remote-runtime-terminal-create-identity'

const DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES = 4_096

export class RemoteRuntimeTerminalCreateIdempotency {
  private readonly inFlight = new Map<
    string,
    { promise: Promise<RuntimeTerminalCreate>; restartIntent?: object }
  >()

  constructor(private readonly maxInFlight = DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES) {}

  run(
    clientIdentity: string,
    worktreeId: string,
    clientMutationId: string,
    create: () => Promise<RuntimeTerminalCreate>,
    kind: TerminalCreateOperationKind = 'create',
    restartIntent?: object
  ): Promise<RuntimeTerminalCreate> {
    const key = JSON.stringify([kind, clientIdentity, worktreeId, clientMutationId])
    const existing = this.inFlight.get(key)
    if (existing) {
      if (
        existing.restartIntent !== restartIntent &&
        !isDeepStrictEqual(existing.restartIntent, restartIntent)
      ) {
        return Promise.reject(new Error('terminal_create_identity_conflict'))
      }
      return existing.promise
    }
    if (this.inFlight.size >= this.maxInFlight) {
      return Promise.reject(
        new Error('Too many terminal creations are still pending; retry after they settle.')
      )
    }

    const promise = create()
    this.inFlight.set(key, { promise, restartIntent })
    const drop = (): void => {
      if (this.inFlight.get(key)?.promise === promise) {
        this.inFlight.delete(key)
      }
    }
    void promise.then(drop, drop)
    return promise
  }
}
