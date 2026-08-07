import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const RECOVERY_RELOAD_INTENT_TTL_MS = 30_000

export type RendererLoadKind = 'ordinary' | 'recovery' | 'unknown'

type RendererNavigationArm = {
  kind: 'ordinary' | 'recovery'
  token?: string
  remainingMs: number
  lastObservedAt: number
}

type PendingRendererLoad = {
  sequence: number
  kind: RendererLoadKind
  recoveryToken?: string
}

type WebContentsRecoveryState = {
  navigationSequence: number
  pendingLoad: PendingRendererLoad | null
  arm: RendererNavigationArm | null
  nextNavigationUnknown: boolean
}

type RecoveryReloadIntentOptions = {
  now?: () => number
  createToken?: () => string
  durationMs?: number
}

export type RecoveryReloadIntent = {
  begin: (webContentsId: number) => string
  armOrdinary: (webContentsId: number) => void
  cancelOrdinary: (webContentsId: number) => boolean
  cancel: (webContentsId: number, token: string) => boolean
  noteNavigationStarted: (webContentsId: number) => void
  classifyLoad: (webContentsId: number) => RendererLoadKind
  forget: (webContentsId: number) => void
}

export function createRecoveryReloadIntent({
  // Monotonic; on Windows it also advances while the system is suspended.
  now = () => performance.now(),
  createToken = randomUUID,
  durationMs = RECOVERY_RELOAD_INTENT_TTL_MS
}: RecoveryReloadIntentOptions = {}): RecoveryReloadIntent {
  const states = new Map<number, WebContentsRecoveryState>()

  const getState = (webContentsId: number): WebContentsRecoveryState => {
    const existing = states.get(webContentsId)
    if (existing) {
      return existing
    }
    const created: WebContentsRecoveryState = {
      navigationSequence: 0,
      pendingLoad: null,
      arm: null,
      nextNavigationUnknown: false
    }
    states.set(webContentsId, created)
    return created
  }

  const refreshArm = (state: WebContentsRecoveryState): RendererNavigationArm | null => {
    const arm = state.arm
    if (!arm) {
      return null
    }
    const observedAt = now()
    if (observedAt < arm.lastObservedAt) {
      arm.remainingMs = durationMs
      arm.lastObservedAt = observedAt
      return arm
    }
    const elapsedMs = observedAt - arm.lastObservedAt
    if (elapsedMs >= arm.remainingMs) {
      state.arm = null
      state.nextNavigationUnknown = true
      return null
    }
    arm.remainingMs -= elapsedMs
    arm.lastObservedAt = observedAt
    return arm
  }

  const armNavigation = (
    state: WebContentsRecoveryState,
    kind: 'ordinary' | 'recovery',
    token?: string
  ): void => {
    const existing = refreshArm(state)
    if (state.pendingLoad) {
      state.pendingLoad = { ...state.pendingLoad, kind: 'unknown' }
    }
    // Overlapping arms: the next navigation belongs to neither, so refuse to guess.
    if (existing) {
      state.arm = null
      state.nextNavigationUnknown = true
      return
    }
    state.arm = {
      kind,
      token,
      remainingMs: durationMs,
      lastObservedAt: now()
    }
    state.nextNavigationUnknown = false
  }

  return {
    begin(webContentsId) {
      const token = createToken()
      armNavigation(getState(webContentsId), 'recovery', token)
      return token
    },
    armOrdinary(webContentsId) {
      armNavigation(getState(webContentsId), 'ordinary')
    },
    cancelOrdinary(webContentsId) {
      const state = getState(webContentsId)
      const arm = refreshArm(state)
      if (arm?.kind === 'ordinary') {
        state.arm = null
        state.nextNavigationUnknown = false
        return true
      }
      if (state.pendingLoad?.kind === 'ordinary') {
        state.pendingLoad = { ...state.pendingLoad, kind: 'unknown' }
        return true
      }
      return false
    },
    cancel(webContentsId, token) {
      const state = getState(webContentsId)
      const arm = refreshArm(state)
      if (arm?.kind === 'recovery' && arm.token === token) {
        state.arm = null
        state.nextNavigationUnknown = false
        return true
      }
      if (state.pendingLoad?.kind === 'recovery' && state.pendingLoad.recoveryToken === token) {
        state.pendingLoad = { ...state.pendingLoad, kind: 'unknown' }
        return true
      }
      return false
    },
    noteNavigationStarted(webContentsId) {
      const state = getState(webContentsId)
      const arm = refreshArm(state)
      state.navigationSequence += 1

      if (state.pendingLoad) {
        state.pendingLoad = { sequence: state.navigationSequence, kind: 'unknown' }
        state.arm = null
        state.nextNavigationUnknown = false
        return
      }
      if (state.nextNavigationUnknown) {
        state.pendingLoad = { sequence: state.navigationSequence, kind: 'unknown' }
        state.nextNavigationUnknown = false
        return
      }
      if (!arm) {
        state.pendingLoad = { sequence: state.navigationSequence, kind: 'unknown' }
        return
      }
      state.pendingLoad = {
        sequence: state.navigationSequence,
        kind: arm.kind,
        ...(arm.kind === 'recovery' ? { recoveryToken: arm.token } : {})
      }
      state.arm = null
    },
    classifyLoad(webContentsId) {
      const state = getState(webContentsId)
      refreshArm(state)
      const pending = state.pendingLoad
      if (!pending) {
        return 'unknown'
      }
      state.pendingLoad = null
      return pending.kind
    },
    forget(webContentsId) {
      states.delete(webContentsId)
    }
  }
}
