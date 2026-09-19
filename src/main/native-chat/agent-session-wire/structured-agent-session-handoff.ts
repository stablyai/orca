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
  structuredHandoffRetryIsAdmissible
} from './structured-agent-session-handoff-admission'
import {
  createStructuredHandoffFlowContext,
  requireStructuredHandoffRecord
} from './structured-agent-session-handoff-flow-context'
import { StructuredAgentSessionHandoffFlowRunner } from './structured-agent-session-handoff-flow-runner'
import { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import { StructuredAgentSessionHandoffQueue } from './structured-agent-session-handoff-queue'
import { queueStructuredHandoffAfterTurn } from './structured-agent-session-handoff-queue-start'
import { closeRetainedTuiOwner } from './structured-agent-session-handoff-owner-close'
import { requestStructuredManualRecovery } from './structured-agent-session-handoff-recover'
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
  StructuredAgentSessionHandoffFlowContext
} from './structured-agent-session-handoff-types'
import { StructuredAgentSessionHandoffState } from './structured-agent-session-handoff-state'
export class StructuredAgentSessionHandoffCoordinator {
  private readonly state: StructuredAgentSessionHandoffState
  private readonly queue = new StructuredAgentSessionHandoffQueue()
  private readonly operationGuard: StructuredAgentSessionHandoffOperationGuard
  private readonly flowRunner: StructuredAgentSessionHandoffFlowRunner
  constructor(private readonly deps: StructuredAgentSessionHandoffDeps) {
    this.state = new StructuredAgentSessionHandoffState({
      requireRecord: (sessionId) => this.requireRecord(sessionId),
      publish: deps.publish,
      hostLabel: deps.transport?.hostLabel
    })
    this.operationGuard = new StructuredAgentSessionHandoffOperationGuard(deps.store)
    this.flowRunner = new StructuredAgentSessionHandoffFlowRunner({
      deps,
      operationGuard: this.operationGuard,
      flowContext: () => this.flowContext(),
      fail: (params, error) => this.fail(params, error)
    })
  }
  status = (sessionId: string): AgentSessionHandoffStatus => this.state.status(sessionId)
  drain = (): Promise<void> => this.flowRunner.drain()
  closeRetainedTuiOwner = (sessionId: string): Promise<boolean> =>
    this.closeRetainedOwner(sessionId)
  setStatus = (sessionId: string, status: AgentSessionHandoffStatus): void =>
    this.state.setStatus(sessionId, status)
  async request(
    callerKey: string,
    params: AgentSessionHandoffRequest
  ): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
    const record = this.requireRecord(params.envelope.sessionId)
    const currentStatus = this.state.cachedStatus(record.sessionId)
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
    const action = params.action ?? 'start'
    if (action === 'cancel-queued') {
      if (currentStatus?.phase !== 'queued' || currentStatus?.direction !== params.direction) {
        return this.refuseAdmitted(
          callerKey,
          params,
          'agent_session_operation_conflict',
          'No matching queued handoff exists.'
        )
      }
      this.queue.cancel(record.sessionId)
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
      const status = this.status(record.sessionId)
      const started = await requestStructuredManualRecovery({
        deps: this.deps,
        operationGuard: this.operationGuard,
        callerKey,
        params,
        fingerprint,
        record,
        status,
        requireRecord: this.requireRecord,
        restore: this.restore,
        setStatus: this.setStatus
      })
      if (!started) {
        return this.refuseAdmitted(
          callerKey,
          params,
          'agent_session_operation_conflict',
          'This handoff is no longer eligible for proof recovery.'
        )
      }
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
      this.begin(callerKey, params, null, fingerprint)
      return this.success(record.sessionId, false)
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
    const tuiOwner = this.state.owner(record.sessionId)
    const busy =
      expectedOwner === 'native'
        ? turnId !== null
        : structuredTuiStatus(tuiOwner, this.deps.transport) !== 'idle'
    if (busy && params.mode === 'now') {
      return this.refuseAdmitted(
        callerKey,
        params,
        'agent_session_conflict',
        'The current turn must finish before switching.'
      )
    }
    if (busy && params.mode === 'after-turn') {
      queueStructuredHandoffAfterTurn({
        callerKey,
        params,
        deps: this.deps,
        queue: this.queue,
        owner: (sessionId) => this.state.owner(sessionId),
        setStatus: this.setStatus,
        begin: (key, next, tuiAlreadyExited) =>
          this.begin(key, next, null, fingerprint, tuiAlreadyExited)
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
  async restore(sessionId: string): Promise<void> {
    await restoreStructuredAgentSessionHandoff(
      {
        deps: this.deps,
        requireRecord: (id) => this.requireRecord(id),
        flowContext: () => this.flowContext(),
        retainOwner: (id, owner) => this.state.retainOwner(id, owner),
        setStatus: (id, status) => this.state.setStatus(id, status)
      },
      sessionId
    )
  }
  private refuseAdmitted(
    callerKey: string,
    params: AgentSessionHandoffRequest,
    code: AgentSessionWireRefusal['code'],
    message: string
  ): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
    return refuseAdmittedStructuredHandoff({
      deps: this.deps,
      callerKey,
      params,
      refusal: refusal(code, message)
    })
  }
  private success(
    sessionId: string,
    replayed: boolean
  ): AgentSessionMutationResult<AgentSessionHandoffResult> {
    return structuredHandoffSuccess(this.deps, sessionId, replayed, this.status(sessionId))
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
      owner: (sessionId) => this.state.owner(sessionId),
      retainOwner: (sessionId, owner) => this.state.retainOwner(sessionId, owner),
      releaseOwner: (sessionId) => this.state.releaseOwner(sessionId),
      setStatus: (sessionId, status) => this.state.setStatus(sessionId, status),
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
  private closeRetainedOwner(sessionId: string): Promise<boolean> {
    return closeRetainedTuiOwner({
      sessionId,
      deps: this.deps,
      owner: this.state.owner,
      requireRecord: this.requireRecord,
      releaseOwner: this.state.releaseOwner
    })
  }
  private requireRecord = (sessionId: string): AgentSessionRecord =>
    requireStructuredHandoffRecord(this.deps, sessionId)
}
