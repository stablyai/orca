import { randomBytes } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'

const DELAYS_MS = [10_000, 30_000, 60_000] as const

export type TransientRecoverySnapshot = {
  turnId: string
  fence: number
  epoch: string
  sequence: number
  userItemId: string | null
  error: string | null
}

type Recovery = {
  turnId: string
  attempts: number
  automaticUserItemId?: string
  timer?: ReturnType<typeof setTimeout>
}

export type TransientRecoveryPolicy = {
  enabled: () => boolean
  onDisabled?: (listener: () => void) => () => void
}

type RecoveryDeps = TransientRecoveryPolicy & {
  now?: () => number
  onCompleted?: (
    listener: (sessionId: string, turnId: string, outcome: string) => void
  ) => () => void
  snapshot: (sessionId: string) => TransientRecoverySnapshot | null
  /** beforeRun is checked inside the session's existing serial acceptance lock. */
  send: (sessionId: string, operationId: string, beforeRun: () => void) => Promise<boolean>
  logger: StructuredAgentSessionLogger
}

/** Host-owned, live-only retries: restarting or reopening a chat never replays a historical error. */
export class StructuredAgentSessionTransientRecovery {
  private readonly recoveries = new Map<string, Recovery>()
  private disposed = false
  private readonly stopWatching?: () => void
  private readonly stopCompletions?: () => void

  constructor(private readonly deps: RecoveryDeps) {
    this.stopWatching = deps.onDisabled?.(() => this.cancelAll())
    this.stopCompletions = deps.onCompleted?.((...args) => this.completed(...args))
  }

  completed(sessionId: string, turnId: string, outcome: string): void {
    const previous = this.recoveries.get(sessionId)
    if (previous?.turnId === turnId) {
      return
    }
    const snapshot = this.deps.snapshot(sessionId)
    if (
      this.disposed ||
      !this.deps.enabled() ||
      outcome !== 'failure' ||
      !snapshot?.error ||
      snapshot.turnId !== turnId
    ) {
      this.cancel(sessionId)
      return
    }
    if (previous?.timer) {
      clearTimeout(previous.timer)
    }
    const recovery: Recovery = {
      turnId,
      attempts: previous?.automaticUserItemId === snapshot.userItemId ? previous.attempts : 0
    }
    this.recoveries.set(sessionId, recovery)
    const delay = DELAYS_MS[recovery.attempts]
    if (delay === undefined) {
      return
    }
    const expected = { ...snapshot }
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined
      void this.continue(sessionId, recovery, expected)
    }, delay)
    recovery.timer.unref?.()
  }

  cancel(sessionId: string): void {
    const recovery = this.recoveries.get(sessionId)
    if (recovery?.timer) {
      clearTimeout(recovery.timer)
    }
    this.recoveries.delete(sessionId)
  }

  beforeUserAction<T>(sessionId: string, action: () => T): T {
    this.cancel(sessionId)
    return action()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.stopWatching?.()
    this.stopCompletions?.()
    this.cancelAll()
  }

  private cancelAll(): void {
    for (const sessionId of this.recoveries.keys()) {
      this.cancel(sessionId)
    }
  }

  private stillWanted(
    sessionId: string,
    recovery: Recovery,
    expected: TransientRecoverySnapshot
  ): boolean {
    if (this.disposed || !this.deps.enabled() || this.recoveries.get(sessionId) !== recovery) {
      return false
    }
    const current = this.deps.snapshot(sessionId)
    return (
      current !== null &&
      current.turnId === expected.turnId &&
      current.error === expected.error &&
      current.fence === expected.fence &&
      current.epoch === expected.epoch &&
      current.sequence === expected.sequence
    )
  }

  private async continue(
    sessionId: string,
    recovery: Recovery,
    expected: TransientRecoverySnapshot
  ): Promise<void> {
    if (!this.stillWanted(sessionId, recovery, expected)) {
      return
    }
    const operationId = `${this.deps.now?.() ?? Date.now()}-${randomBytes(16).toString('hex')}`
    recovery.attempts++
    recovery.automaticUserItemId = agentJournalSubmissionKey(operationId)
    try {
      await this.deps.send(sessionId, operationId, () => {
        if (!this.stillWanted(sessionId, recovery, expected)) {
          throw new AgentSessionPreDispatchError('agent_session_transient_recovery_superseded')
        }
      })
    } catch (error) {
      if (!(error instanceof AgentSessionPreDispatchError)) {
        this.deps.logger.warn(
          'automatic continuation could not be confirmed; no resend attempted',
          {
            scope: 'transient-error-recovery',
            sessionId,
            error
          }
        )
      }
    }
  }
}
