import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'

type ActivationGateState = Exclude<RuntimeDesktopWindowStatus, 'available' | 'openable'> | 'ready'

export type ServeDesktopActivationGate = {
  getState: () => ActivationGateState
  requestActivation: () => void
  markReady: () => void
  markBlocked: (reason: string) => void
}

export const SERVE_DESKTOP_ACTIVATION_BLOCKED_REASON = 'persistent PTY provider unavailable'

/**
 * Why: promotion is only safe when serve owns daemon-backed (persistent) PTYs —
 * the desktop renderer then reattaches the surviving sessions instead of
 * cold-restoring them. Without that provider, fail closed (#8457).
 */
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
