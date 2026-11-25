import { HOST_LOST_EXIT_CAUSE } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { DaemonPtyRouterExitEvent } from '../../protocol/daemon-pty-router-events'

export function emitPtyListeners<T>(listeners: readonly T[], emit: (listener: T) => void): void {
  // Callbacks may change subscriptions; those changes apply to the next emission.
  listeners.slice().forEach(emit)
}

export function createPtyExitPayload(
  id: string,
  { code, incarnationId, cause, replacedByRestart, hostLost }: Omit<DaemonPtyRouterExitEvent, 'id'>
): DaemonPtyRouterExitEvent {
  return {
    id,
    code,
    ...(incarnationId ? { incarnationId } : {}),
    // Host loss is no stop request: without this a bare -1 reads as an unconfirmed stop.
    ...(cause || hostLost ? { cause: cause ?? HOST_LOST_EXIT_CAUSE } : {}),
    ...(replacedByRestart ? { replacedByRestart } : {}),
    ...(hostLost ? { hostLost } : {})
  }
}
