import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'

type ActivationGateState = Exclude<RuntimeDesktopWindowStatus, 'available' | 'openable'> | 'ready'

export type ServeDesktopActivationGate = {
  getState: () => ActivationGateState
  requestActivation: () => void
  markReady: () => void
  markBlocked: (reason: string) => void
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
