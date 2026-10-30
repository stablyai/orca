import { TERMINAL_SPAWN_DEFERRED_PREFIX } from '../../shared/host-spawn-admission'

export class TerminalSpawnDeferredError extends Error {
  constructor(readonly reason: string) {
    super(`${TERMINAL_SPAWN_DEFERRED_PREFIX}${reason}`)
    this.name = 'TerminalSpawnDeferredError'
  }
}
