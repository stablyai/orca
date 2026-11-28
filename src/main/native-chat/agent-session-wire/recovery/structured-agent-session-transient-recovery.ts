import { randomBytes } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import { AgentSessionPreDispatchError } from '../operations/structured-agent-session-operation-settlement'

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
  snapshot: (sessionId: string) => Promise<TransientRecoverySnapshot | null>
  /** Synchronous re-check of the snapshot's journal position, for the acceptance lock. */
  unchanged: (sessionId: string, expected: TransientRecoverySnapshot) => boolean
  /** beforeRun is checked inside the session's existing serial acceptance lock. */
  send: (sessionId: string, operationId: string, beforeRun: () => void) => Promise<boolean>
  logger: StructuredAgentSessionLogger
}

/** Host-owned, live-only retries: restarting or reopening a chat never replays a historical error. */
export class StructuredAgentSessionTransientRecovery {
  private readonly recoveries = new Map<string, Recovery>()
  private cancellations = 0
  private disposed = false
  private readonly stopWatching?: () => void
  private readonly stopCompletions?: () => void

  constructor(private readonly deps: RecoveryDeps) {
    this.stopWatching = deps.onDisabled?.(() => this.cancelAll())
    this.stopCompletions = deps.onCompleted?.((...args) => this.completed(...args))
  }

  completed(sessionId: string, turnId: string, outcome: string): void {
    void this.observeCompletion(sessionId, turnId, outcome)
  }

  private async observeCompletion(
    sessionId: string,
    turnId: string,
    outcome: string
  ): Promise<void> {
    if (this.recoveries.get(sessionId)?.turnId === turnId) {
      return
    }
    const cancellations = this.cancellations
    const snapshot = await this.deps.snapshot(sessionId)
    // A cancel during the journal read wins: whatever it withdrew must not come back.
    if (cancellations !== this.cancellations) {
      return
    }
    const previous = this.recoveries.get(sessionId)
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
    this.cancellations++
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
    this.cancellations++
    for (const sessionId of this.recoveries.keys()) {
      this.cancel(sessionId)
    }
  }

  private registered(sessionId: string, recovery: Recovery): boolean {
    return !this.disposed && this.deps.enabled() && this.recoveries.get(sessionId) === recovery
  }

  private async stillWanted(
    sessionId: string,
    recovery: Recovery,
    expected: TransientRecoverySnapshot
  ): Promise<boolean> {
    if (!this.registered(sessionId, recovery)) {
      return false
    }
    const current = await this.deps.snapshot(sessionId)
    return (
      current !== null &&
      current.turnId === expected.turnId &&
      current.error === expected.error &&
      current.fence === expected.fence &&
      current.epoch === expected.epoch &&
      current.sequence === expected.sequence &&
      this.registered(sessionId, recovery)
    )
  }

  private async continue(
    sessionId: string,
    recovery: Recovery,
    expected: TransientRecoverySnapshot
  ): Promise<void> {
    if (!(await this.stillWanted(sessionId, recovery, expected))) {
      return
    }
    const operationId = `${this.deps.now?.() ?? Date.now()}-${randomBytes(16).toString('hex')}`
    recovery.attempts++
    recovery.automaticUserItemId = agentJournalSubmissionKey(operationId)
    try {
      await this.deps.send(sessionId, operationId, () => {
        if (!this.registered(sessionId, recovery) || !this.deps.unchanged(sessionId, expected)) {
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
