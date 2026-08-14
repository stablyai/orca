import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import {
  admitStructuredHandoffRequest,
  refuseAdmittedStructuredHandoff,
  replayedStructuredHandoffRefusal,
  structuredHandoffRetryIsAdmissible,
  structuredHandoffRetryResumesStoppedOwner
} from './structured-agent-session-handoff-admission'
import {
  createStructuredHandoffFlowContext,
  requireStructuredHandoffRecord
} from './structured-agent-session-handoff-flow-context'
import { StructuredAgentSessionHandoffFlowRunner } from './structured-agent-session-handoff-flow-runner'
import {
  beginStructuredManualRecovery,
  structuredManualRecoveryIsAdmissible
} from './structured-agent-session-manual-recovery'
import {
  enqueueStructuredHandoffAfterTurn,
  StructuredAgentSessionHandoffQueue
} from './structured-agent-session-handoff-queue'
import { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import { restoreStructuredAgentSessionHandoff } from './structured-agent-session-handoff-restart'
import {
  structuredHandoffRefusal as refusal,
  structuredHandoffSuccess
} from './structured-agent-session-handoff-result'
import {
  failedStructuredHandoffStatus,
  idleStructuredHandoffStatus,
  structuredSessionHasPendingPrompt,
  structuredTuiStatus
} from './structured-agent-session-handoff-status'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export class StructuredAgentSessionHandoffCoordinator {
  private readonly statuses = new Map<string, AgentSessionHandoffStatus>()
  private readonly queue = new StructuredAgentSessionHandoffQueue()
  private readonly tuiOwners = new Map<string, StructuredTuiOwner>()
  private readonly operationGuard: StructuredAgentSessionHandoffOperationGuard
  private readonly flowRunner: StructuredAgentSessionHandoffFlowRunner

  constructor(private readonly deps: StructuredAgentSessionHandoffDeps) {
    this.operationGuard = new StructuredAgentSessionHandoffOperationGuard(deps.store)
    this.flowRunner = new StructuredAgentSessionHandoffFlowRunner({
      deps,
      operationGuard: this.operationGuard,
      flowContext: () => this.flowContext(),
      fail: (params, error) => this.fail(params, error)
    })
  }

  status = (sessionId: string): AgentSessionHandoffStatus =>
    this.statuses.get(sessionId) ?? idleStructuredHandoffStatus(this.requireRecord(sessionId))

  drain = (): Promise<void> => this.flowRunner.drain()

  async restore(sessionId: string): Promise<void> {
    await restoreStructuredAgentSessionHandoff(
      {
        deps: this.deps,
        requireRecord: (id) => this.requireRecord(id),
        flowContext: () => this.flowContext(),
        retainOwner: (id, owner) => this.tuiOwners.set(id, owner),
        setStatus: (id, status) => this.setStatus(id, status)
      },
      sessionId
    )
  }

  async request(
    callerKey: string,
    params: AgentSessionHandoffRequest
  ): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
    let record = this.requireRecord(params.envelope.sessionId)
    const currentStatus = this.statuses.get(record.sessionId)
    const admission = await admitStructuredHandoffRequest({
      deps: this.deps,
      operationGuard: this.operationGuard,
      callerKey,
      params,
      record,
      ...(currentStatus ? { status: currentStatus } : {})
    })
    if (admission.decision === 'replay') {
      const replayedRefusal = replayedStructuredHandoffRefusal(admission.outcome)
      if (replayedRefusal) {
        return { ok: false, refusal: replayedRefusal }
      }
      return this.success(record.sessionId, true)
    }
    if (admission.decision === 'refused') {
      return { ok: false, refusal: admission.refusal }
    }
    const { fingerprint } = admission
    record = this.requireRecord(params.envelope.sessionId)
    const admittedStatus = this.statuses.get(record.sessionId)
    const action = params.action ?? 'start'
    if (action === 'cancel-queued') {
      if (
        admittedStatus?.phase !== 'queued' ||
        admittedStatus.operationId === null ||
        admittedStatus.direction !== params.direction ||
        !this.queue.cancel(record.sessionId)
      ) {
        return this.refuseAdmitted(
          callerKey,
          params,
          'agent_session_operation_conflict',
          'No matching queued handoff exists.'
        )
      }
      await this.operationGuard.settle(record.sessionId, admittedStatus.operationId, {
        status: 'failed',
        code: 'agent_session_operation_conflict'
      })
      this.setStatus(record.sessionId, idleStructuredHandoffStatus(record))
      await this.deps.store.recordOperationOutcome({
        callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: { status: 'succeeded', sessionId: record.sessionId }
      })
      return this.success(record.sessionId, false)
    }
    if (!this.deps.transport) {
      return this.refuseAdmitted(
        callerKey,
        params,
        'structured_agent_session_unsupported',
        'Agent TUI handoff is unavailable on this host.'
      )
    }
    if (action === 'recover') {
      if (!structuredManualRecoveryIsAdmissible(record, admittedStatus)) {
        return this.refuseAdmitted(
          callerKey,
          params,
          'agent_session_operation_conflict',
          'This session no longer has a recoverable TUI proof.'
        )
      }
      const recovery = beginStructuredManualRecovery({
        deps: this.deps,
        operationGuard: this.operationGuard,
        callerKey,
        params,
        fingerprint,
        requireRecord: (sessionId) => this.requireRecord(sessionId),
        restore: (sessionId) => this.restore(sessionId),
        setStatus: (sessionId, status) => this.setStatus(sessionId, status)
      })
      this.flowRunner.track(recovery)
      return this.success(record.sessionId, false)
    }
    if (action === 'retry') {
      if (!structuredHandoffRetryIsAdmissible(this.status(record.sessionId), params)) {
        return this.refuseAdmitted(
          callerKey,
          params,
          'agent_session_operation_conflict',
          'This handoff is no longer retryable.'
        )
      }
      if (structuredHandoffRetryResumesStoppedOwner(record, params)) {
        this.begin(callerKey, params, null, fingerprint)
        return this.success(record.sessionId, false)
      }
    }
    const expectedOwner = params.direction === 'to-tui' ? 'native' : 'tui'
    if (record.lease.runtimeKind !== expectedOwner || record.lease.claimStatus !== 'live') {
      return this.refuseAdmitted(
        callerKey,
        params,
        'agent_session_conflict',
        `The ${expectedOwner} runtime does not own this session.`
      )
    }
    if (structuredSessionHasPendingPrompt(this.deps.session(record.sessionId).journal)) {
      return this.refuseAdmitted(
        callerKey,
        params,
        'agent_session_conflict',
        'Resolve the pending question or approval before switching.'
      )
    }
    const turnId = activeStructuredAgentSessionTurnId(
      this.deps.session(record.sessionId).journal.snapshot().items
    )
    const tuiOwner = this.tuiOwners.get(record.sessionId)
    const busy =
      turnId !== null ||
      (expectedOwner === 'tui' &&
        (params.mode === 'after-turn' ||
          structuredTuiStatus(tuiOwner, this.deps.transport) !== 'idle'))
    if (busy && params.mode === 'now') {
      return this.refuseAdmitted(
        callerKey,
        params,
        'agent_session_conflict',
        'The current turn must finish before switching.'
      )
    }
    if (busy && params.mode === 'after-turn') {
      enqueueStructuredHandoffAfterTurn({
        deps: this.deps,
        queue: this.queue,
        params,
        tuiOwner,
        status: () => this.status(record.sessionId),
        requireRecord: () => this.requireRecord(record.sessionId),
        setStatus: (status) => this.setStatus(record.sessionId, status),
        begin: (next, exited) => this.begin(callerKey, next, null, fingerprint, exited),
        refuse: (latest) => this.refuseQueued(params, latest)
      })
      return this.success(record.sessionId, false)
    }
    if (busy && expectedOwner === 'tui' && params.mode === 'stop-turn') {
      return this.refuseAdmitted(
        callerKey,
        params,
        'structured_agent_session_unsupported',
        'Exit the agent terminal after this turn to continue in chat.'
      )
    }
    this.begin(callerKey, params, turnId, fingerprint)
    return this.success(record.sessionId, false)
  }

  private async refuseAdmitted(
    callerKey: string,
    params: AgentSessionHandoffRequest,
    code: AgentSessionWireRefusal['code'],
    message: string
  ): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
    const result = await refuseAdmittedStructuredHandoff({
      deps: this.deps,
      callerKey,
      params,
      refusal: refusal(code, message)
    })
    this.operationGuard.finish(params.envelope.sessionId, params.envelope.clientOperationId)
    return result
  }

  private success = (sessionId: string, replayed: boolean) =>
    structuredHandoffSuccess(this.deps, sessionId, replayed, this.status(sessionId))

  private refuseQueued(params: AgentSessionHandoffRequest, record: AgentSessionRecord): void {
    const settlement = this.operationGuard
      .settle(record.sessionId, params.envelope.clientOperationId, {
        status: 'failed',
        code: 'agent_session_checkpoint_stale'
      })
      .then(() => this.setStatus(record.sessionId, idleStructuredHandoffStatus(record)))
      .catch((error) => this.fail(params, error))
    this.flowRunner.track(settlement)
  }

  private begin(
    callerKey: string,
    params: AgentSessionHandoffRequest,
    turnId: string | null,
    fingerprint: string,
    tuiAlreadyExited = false
  ): void {
    this.flowRunner.begin({
      callerKey,
      params,
      turnId,
      fingerprint,
      tuiAlreadyExited
    })
  }

  private flowContext(): StructuredAgentSessionHandoffFlowContext {
    return createStructuredHandoffFlowContext({
      deps: this.deps,
      owner: (sessionId) => this.tuiOwners.get(sessionId),
      retainOwner: (sessionId, owner) => this.tuiOwners.set(sessionId, owner),
      releaseOwner: (sessionId) => void this.tuiOwners.delete(sessionId),
      setStatus: (sessionId, status) => this.setStatus(sessionId, status),
      requireRecord: (sessionId) => this.requireRecord(sessionId)
    })
  }

  private fail(params: AgentSessionHandoffRequest, error: unknown): void {
    const record = this.requireRecord(params.envelope.sessionId)
    this.setStatus(
      record.sessionId,
      failedStructuredHandoffStatus(record, params, error, this.deps.transport?.hostLabel)
    )
  }

  setStatus(sessionId: string, status: AgentSessionHandoffStatus): void {
    this.statuses.set(sessionId, status)
    this.deps.publish(sessionId, status)
  }

  private requireRecord(sessionId: string): AgentSessionRecord {
    return requireStructuredHandoffRecord(this.deps, sessionId)
  }
}
