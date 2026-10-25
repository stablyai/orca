import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'

type ActivationGateState = Exclude<RuntimeDesktopWindowStatus, 'available' | 'openable'> | 'ready'

export type ServeDesktopActivationGate = {
  getState: () => ActivationGateState
  requestActivation: () => void
  markReady: () => void
  markBlocked: (reason: string) => void
}

export const SERVE_DESKTOP_ACTIVATION_BLOCKED_REASON = 'persistent PTY provider unavailable'

/** Fail closed unless daemon-backed PTYs can survive desktop promotion and renderer reattachment (#8457). */
export function settleServeDesktopActivation(
  gate: ServeDesktopActivationGate,
  options: { hasPersistentPtyProvider: boolean }
): void {
  if (!options.hasPersistentPtyProvider) {
    gate.markBlocked(SERVE_DESKTOP_ACTIVATION_BLOCKED_REASON)
    return
  }
  gate.markReady()
}

/** Release queued activations only after the startup opener returns, so they focus its window instead of creating a duplicate. */
export function releaseDesktopActivationAfter<TArgs extends unknown[], TResult>(
  gate: ServeDesktopActivationGate | null,
  open: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  return (...args) => {
    const result = open(...args)
    gate?.markReady()
    return result
  }
}

export function createServeDesktopActivationGate(options: {
  initialState: 'initializing' | 'ready'
  activateWindow: () => void
  onBlocked?: (reason: string) => void
}): ServeDesktopActivationGate {
  let state: ActivationGateState = options.initialState
  let pendingActivation = false
  let blockedReason = 'desktop activation is unavailable'

  return {
    getState: () => state,
    requestActivation: () => {
      if (state === 'ready') {
        options.activateWindow()
        return
      }
      if (state === 'initializing') {
        pendingActivation = true
        return
      }
      options.onBlocked?.(blockedReason)
    },
    markReady: () => {
      if (state !== 'initializing') {
        return
      }
      state = 'ready'
      if (pendingActivation) {
        pendingActivation = false
        options.activateWindow()
      }
    },
    markBlocked: (reason) => {
      if (state !== 'initializing') {
        return
      }
      state = 'blocked'
      blockedReason = reason
      if (pendingActivation) {
        pendingActivation = false
        options.onBlocked?.(blockedReason)
      }
    }
  }
}
