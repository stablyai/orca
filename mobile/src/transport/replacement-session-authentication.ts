import type { RpcClient } from './rpc-client'
import {
  relayDialStageBudgetMs,
  relayDialStageSource,
  type RelayDialStage
} from './relay-dial-stage'

export class ReplacementAuthenticationTimeoutError extends Error {
  constructor(
    readonly stage: RelayDialStage | null,
    budgetMs: number
  ) {
    super(
      stage
        ? `replacement session authentication timed out (${stage}, ${Math.round(budgetMs / 1000)}s)`
        : 'replacement session authentication timed out'
    )
    this.name = 'ReplacementAuthenticationTimeoutError'
  }
}

// Cut over only after authenticated connected state; socket open alone is insufficient.
// Give progressing relay stages separate budgets so slow assignment does not restart the same work through director fallback.
export function waitForAuthenticated(session: RpcClient, timeoutMs: number): Promise<void> {
  if (session.getState() === 'connected') {
    return Promise.resolve()
  }
  const stages = relayDialStageSource(session)
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let unsubscribeStage: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    // Why: armed before subscribing — a synchronous notification during registration
    // must find a timer to clear, or a settled wait leaves it running for 12s.
    arm(stages?.getDialStage() ?? null)
    unsubscribe = session.onStateChange((state) => {
      if (state === 'connected') {
        finish()
        resolve()
      } else if (state === 'auth-failed' || state === 'disconnected') {
        finish()
        reject(new Error(`replacement session ${state}`))
      }
    })
    if (settled) {
      // Why: the notification fired inside onStateChange, before we held the handle.
      unsubscribe()
      unsubscribe = null
    } else if (stages) {
      unsubscribeStage = stages.onDialStageChange((stage) => arm(stage))
    }

    function arm(stage: RelayDialStage | null): void {
      if (settled) {
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      const budgetMs =
        stage === null || stage === 'opening' ? timeoutMs : relayDialStageBudgetMs(stage)
      timer = setTimeout(() => {
        finish()
        reject(new ReplacementAuthenticationTimeoutError(stage, budgetMs))
      }, budgetMs)
    }

    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribe?.()
      unsubscribe = null
      unsubscribeStage?.()
      unsubscribeStage = null
    }
  })
}
