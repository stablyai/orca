import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export type MobileTerminalInventoryRefreshOptions = {
  allowEmptyLoaded?: boolean
  onPhysicalRequestStarted?: (startedAt: number) => void
}

type MobileTerminalInventoryRecoveryAction = {
  request: () => void
  scope: string
}

/** Bridges terminal stream callbacks to the committed route's recovery action. */
export function useMobileTerminalInventoryRecoveryBridge(scopeKey: string) {
  const committedScopeRef = useRef<string | null>(null)
  const actionRef = useRef<MobileTerminalInventoryRecoveryAction | null>(null)
  const pendingSignalScopeRef = useRef<string | null>(null)

  useEffect(() => {
    committedScopeRef.current = scopeKey
    return () => {
      if (committedScopeRef.current === scopeKey) {
        committedScopeRef.current = null
      }
    }
  }, [scopeKey])

  const signalTerminalInventoryRecovery = useCallback(() => {
    const committedScope = committedScopeRef.current
    if (committedScope !== null && committedScope !== scopeKey) {
      return
    }
    const recoveryAction = actionRef.current
    if (recoveryAction?.scope === scopeKey) {
      recoveryAction.request()
      return
    }
    pendingSignalScopeRef.current = scopeKey
  }, [scopeKey])

  const registerTerminalInventoryRecoveryAction = useCallback(
    (request: () => void): (() => void) => {
      const recoveryAction = { request, scope: scopeKey }
      actionRef.current = recoveryAction
      const pendingScope = pendingSignalScopeRef.current
      pendingSignalScopeRef.current = null
      if (pendingScope === scopeKey) {
        request()
      }
      return () => {
        if (actionRef.current === recoveryAction) {
          actionRef.current = null
        }
      }
    },
    [scopeKey]
  )

  return {
    registerTerminalInventoryRecoveryAction,
    signalTerminalInventoryRecovery
  }
}

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  fetchTerminals: (options?: MobileTerminalInventoryRefreshOptions) => Promise<boolean>
  scopeKey: string
}

type RecoveryState = {
  active: boolean
  generation: number
  pending: boolean
  phase: 'idle' | 'first-pass' | 'confirmation-wait' | 'confirmation-pass'
  timer: ReturnType<typeof setTimeout> | null
}

const CERTIFIED_TERMINAL_SWEEP_MS = 60_000
const TERMINAL_INVENTORY_CONFIRMATION_DELAY_MS = 750

export function useMobileTerminalInventoryRecovery({
  client,
  connState,
  fetchTerminals,
  scopeKey
}: Params) {
  const stateRef = useRef<RecoveryState>({
    active: false,
    generation: 0,
    pending: false,
    phase: 'idle',
    timer: null
  })
  const lastAttemptAtRef = useRef(Number.NEGATIVE_INFINITY)
  const refreshTerminalInventory = useCallback(
    async (options?: MobileTerminalInventoryRefreshOptions): Promise<boolean> => {
      const logicalStartedAt = Date.now()
      const generation = stateRef.current.generation
      let physicalStartReported = false
      try {
        return await fetchTerminals({
          ...options,
          onPhysicalRequestStarted: (startedAt) => {
            physicalStartReported = true
            if (stateRef.current.generation === generation) {
              lastAttemptAtRef.current = startedAt
            }
          }
        })
      } finally {
        if (!physicalStartReported && stateRef.current.generation === generation) {
          lastAttemptAtRef.current = logicalStartedAt
        }
      }
    },
    [fetchTerminals]
  )
  const isCertifiedTerminalSweepDue = useCallback((now: number): boolean => {
    const elapsed = now - lastAttemptAtRef.current
    return elapsed < 0 || elapsed >= CERTIFIED_TERMINAL_SWEEP_MS
  }, [])
  const resetCertifiedTerminalSweep = useCallback(() => {
    lastAttemptAtRef.current = Number.NEGATIVE_INFINITY
  }, [])
  const canRun = useCallback(
    () =>
      stateRef.current.active &&
      AppState.currentState === 'active' &&
      connState === 'connected' &&
      (client?.getState?.() ?? connState) === 'connected',
    [client, connState]
  )
  const suspendTerminalInventoryRecovery = useCallback((retainPending: boolean): void => {
    const state = stateRef.current
    state.active = false
    state.generation += 1
    state.pending = retainPending && (state.pending || state.phase !== 'idle')
    state.phase = 'idle'
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }, [])
  const activateTerminalInventoryRecovery = useCallback(() => {
    stateRef.current.active = true
  }, [])
  const requestTerminalInventoryRecovery = useCallback((): void => {
    const state = stateRef.current
    if (!canRun()) {
      state.pending = true
      return
    }
    if (state.phase === 'first-pass' || state.phase === 'confirmation-pass') {
      state.pending = true
      return
    }
    if (state.phase === 'confirmation-wait') {
      return
    }

    const startCycle = (): void => {
      state.pending = false
      state.phase = 'first-pass'
      const generation = state.generation
      const finishPass = (): void => {
        state.phase = 'idle'
        if (state.pending && canRun()) {
          startCycle()
        }
      }

      void (async () => {
        let firstPassSucceeded = false
        try {
          firstPassSucceeded = await refreshTerminalInventory({ allowEmptyLoaded: true })
        } catch {
          // A failed inventory is unverifiable.
        }
        if (generation !== state.generation) {
          return
        }
        if (!firstPassSucceeded) {
          finishPass()
          return
        }
        // The confirmation pass also satisfies signals received during the first pass.
        state.pending = false
        if (!canRun()) {
          state.pending = true
          state.phase = 'idle'
          return
        }
        state.phase = 'confirmation-wait'
        state.timer = setTimeout(() => {
          state.timer = null
          if (generation !== state.generation) {
            return
          }
          if (!canRun()) {
            state.pending = true
            state.phase = 'idle'
            return
          }
          state.phase = 'confirmation-pass'
          void refreshTerminalInventory({ allowEmptyLoaded: true })
            .catch(() => {
              // A transport failure cannot confirm terminal absence.
            })
            .finally(() => {
              if (generation === state.generation) {
                finishPass()
              }
            })
        }, TERMINAL_INVENTORY_CONFIRMATION_DELAY_MS)
      })()
    }

    startCycle()
  }, [canRun, refreshTerminalInventory])
  const resumePendingTerminalInventoryRecovery = useCallback(() => {
    if (stateRef.current.pending) {
      requestTerminalInventoryRecovery()
    }
  }, [requestTerminalInventoryRecovery])

  useEffect(
    () => () => {
      suspendTerminalInventoryRecovery(false)
      lastAttemptAtRef.current = Number.NEGATIVE_INFINITY
    },
    [scopeKey, suspendTerminalInventoryRecovery]
  )

  return {
    activateTerminalInventoryRecovery,
    isCertifiedTerminalSweepDue,
    refreshTerminalInventory,
    requestTerminalInventoryRecovery,
    resetCertifiedTerminalSweep,
    resumePendingTerminalInventoryRecovery,
    suspendTerminalInventoryRecovery
  }
}
