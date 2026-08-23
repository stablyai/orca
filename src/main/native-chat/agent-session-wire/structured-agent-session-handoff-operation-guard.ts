import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

type ActiveOperation = { callerKey: string; operationId: string; fingerprint: string }

export type HandoffOperationDecision =
  | { decision: 'new' }
  | { decision: 'replay'; outcome: AgentSessionOperationOutcome }
  | { decision: 'retry' }
  | { decision: 'refused'; code: string }

export class StructuredAgentSessionHandoffOperationGuard {
  private readonly activeBySession = new Map<string, ActiveOperation>()

  constructor(private readonly store: AgentSessionRecordStore) {}

  async check(input: {
    callerKey: string
    sessionId: string
    operationId: string
    fingerprint: string
    action: 'start' | 'cancel-queued' | 'retry' | 'recover'
    status?: AgentSessionHandoffStatus
    now: number
  }): Promise<HandoffOperationDecision> {
    const ledger = await this.store.admitOperation({
      callerKey: input.callerKey,
      operationId: input.operationId,
      fingerprint: input.fingerprint,
      now: input.now
    })
    if (ledger.decision === 'refused') {
      return { decision: 'refused', code: ledger.code }
    }
    const active = this.activeBySession.get(input.sessionId)
    const queuedCancellation =
      input.action === 'cancel-queued' &&
      input.status?.phase === 'queued' &&
      input.status.operationId === active?.operationId
    const activeConflict = Boolean(
      active &&
      ((active.operationId === input.operationId &&
        (active.fingerprint !== input.fingerprint || active.callerKey !== input.callerKey)) ||
        (active.operationId !== input.operationId && !queuedCancellation))
    )
    const queuedConflict = Boolean(
      !active &&
      input.status?.phase === 'queued' &&
      input.status.operationId !== input.operationId &&
      input.action !== 'cancel-queued'
    )
    if (activeConflict || queuedConflict) {
      if (ledger.decision === 'admit') {
        await this.store.recordOperationOutcome({
          callerKey: input.callerKey,
          operationId: input.operationId,
          outcome: { status: 'failed', code: 'agent_session_operation_conflict' }
        })
      }
      return { decision: 'refused', code: 'agent_session_operation_conflict' }
    }
    if (ledger.decision === 'admit') {
      this.reserve(input)
      return { decision: 'new' }
    }
    if (input.action === 'retry' && ledger.row.outcome.status === 'failed') {
      await this.store.recordOperationOutcome({
        callerKey: input.callerKey,
        operationId: input.operationId,
        outcome: { status: 'pending' }
      })
      this.reserve(input)
      return { decision: 'retry' }
    }
    if (
      ledger.row.outcome.status === 'pending' &&
      !active &&
      input.status?.operationId !== input.operationId
    ) {
      this.reserve(input)
      return { decision: 'new' }
    }
    return { decision: 'replay', outcome: ledger.row.outcome }
  }

  start(sessionId: string, operation: ActiveOperation): void {
    this.activeBySession.set(sessionId, operation)
  }

  private reserve(input: {
    action: 'start' | 'cancel-queued' | 'retry' | 'recover'
    callerKey: string
    sessionId: string
    operationId: string
    fingerprint: string
  }): void {
    if (input.action !== 'cancel-queued') {
      this.start(input.sessionId, input)
    }
  }

  finish(sessionId: string, operationId: string): void {
    if (this.activeBySession.get(sessionId)?.operationId === operationId) {
      this.activeBySession.delete(sessionId)
    }
  }

  async settle(
    sessionId: string,
    operationId: string,
    outcome: AgentSessionOperationOutcome
  ): Promise<void> {
    const active = this.activeBySession.get(sessionId)
    await this.store.recordOperationOutcome({
      ...(active?.operationId === operationId ? { callerKey: active.callerKey } : {}),
      operationId,
      outcome
    })
    this.finish(sessionId, operationId)
  }
}
