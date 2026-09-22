import type { DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

export function emitPtyListeners<T>(listeners: readonly T[], emit: (listener: T) => void): void {
  // Callbacks may change subscriptions; those changes apply to the next emission.
  listeners.slice().forEach(emit)
}

export function createPtyExitPayload(
  id: string,
  { code, incarnationId, cause }: Omit<DaemonPtyRouterExitEvent, 'id'>
): DaemonPtyRouterExitEvent {
  return {
    id,
    code,
    ...(incarnationId ? { incarnationId } : {}),
    ...(cause ? { cause } : {})
  }
}
