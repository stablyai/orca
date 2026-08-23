// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionCancelResult,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHandoffRequest,
  AgentSessionHandoffResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  admitAndRunAgentSessionMutation,
  AGENT_SESSION_NOT_ATTACHED
} from './structured-agent-session-mutation-admission'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createStructuredAgentSessionHostHandoff,
  refreshRecoverableStructuredHandoffStatus,
  type StructuredAgentSessionHostHandoff
} from './structured-agent-session-host-handoff'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  adoptStructuredTuiOwner,
  type StructuredTuiAdoptionRequest
} from './structured-agent-session-tui-adoption'
import {
  releaseStructuredTuiAdoptionReservation,
  reserveStructuredTuiAdoption,
  type StructuredTuiAdoptionReservationRelease,
  type StructuredTuiAdoptionReservationRequest,
  type StructuredTuiAdoptionReservationResult
} from './structured-agent-session-tui-adoption-reservation'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly sessions = new Map<string, StructuredAgentSessionHostSession>()
  private readonly subscribers = new AgentSessionSubscribers()
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  private readonly handoffs: StructuredAgentSessionHostHandoff
  private readonly readableRestorer: StructuredAgentSessionReadableRestorer
  private readonly restartRestore = new StructuredAgentSessionRestartRestoreGate()

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      (record) => this.restoreRenewedHandoff(record.sessionId),
      (record, probe) =>
        this.sessions.has(record.sessionId)
          ? this.serialize(record.sessionId, () =>
              this.handoffs.recoverDeadTuiOwner(record.sessionId, record.lease.runtimeFence, probe)
            )
          : Promise.resolve()
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      now: () => this.now()
    })
    this.handoffs = createStructuredAgentSessionHostHandoff(deps, {
      session: (sessionId) => this.requireSession(sessionId),
      eventSink: (sessionId) => this.runtimeState.eventSinkFor(sessionId),
      flush: (sessionId) => this.flushStreamedEvents(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      subscribers: this.subscribers,
      now: this.now
    })
    this.readableRestorer = new StructuredAgentSessionReadableRestorer({
      store: deps.store,
      journalRoot: deps.journalRoot,
      supportsRecord: (record) => providerSupport.adapterSupportsRecord(deps.adapter, record),
      reconcile: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      resume: (params) =>
        this.attach({ callerKey: 'trusted-local:host-restart' }, params).then(
          (result) => result.ok
        ),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      onReadable: (sessionId, restored) => this.sessions.set(sessionId, restored),
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId),
      reapOrphanChildren: () => this.runtimeState.reapOrphanChildren(),
      now: this.now
    })
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  listSessionTabs() {
    return listStructuredAgentSessionTabs(this.sessions)
  }

  restoreReadableSessions = (): Promise<void> =>
    this.restartRestore.run(() => this.readableRestorer.restore())

  private serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> =>
    this.tasks.serialize(sessionId, task)

  private restoreRenewedHandoff(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (this.sessions.has(sessionId)) {
        await refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
      }
    })
  }

  /** What attach needs from this host, named so its dependencies cannot grow unnoticed. */
  private attachContext(): StructuredAgentSessionAttachContext {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    }
  }

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
    return attachStructuredAgentSession(this.attachContext(), caller.callerKey, params)
  }

  /** Reserve the lease an adopted TUI must hold before the write gate will admit its proof. */
  reserveAdoptedTuiOwner = (
    input: StructuredTuiAdoptionReservationRequest
  ): Promise<StructuredTuiAdoptionReservationResult> =>
    this.serialize(input.sessionId, () =>
      reserveStructuredTuiAdoption({ ...input, deps: this.deps, now: this.now })
    )

  /** Hand back a reservation whose proof never landed, so the next attempt is not refused by it. */
  releaseAdoptedTuiReservation = (input: StructuredTuiAdoptionReservationRelease): Promise<void> =>
    this.serialize(input.sessionId, () =>
      releaseStructuredTuiAdoptionReservation({ ...input, deps: this.deps, now: this.now })
    )

  adoptTuiOwner = (
    input: StructuredTuiAdoptionRequest
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> =>
    this.serialize(input.params.envelope.sessionId, () =>
      adoptStructuredTuiOwner({
        ...input,
        deps: this.deps,
        now: this.now,
        publish: (sessionId, session) => this.sessions.set(sessionId, session),
        retain: (sessionId, owner) => this.handoffs.adoptTuiOwner(sessionId, owner),
        snapshot: (sessionId, session) =>
          this.subscribers.snapshot(sessionId, session.journal, session.fence)
      })
    )

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  async flushAllStreamedEvents(): Promise<void> {
    this.runtimeState.stopLeaseRenewal()
    this.handoffs.stopTuiHistoryCatchup()
    await this.tasks.drainAttaches()
    await this.runtimeState.flushAllEventSinks()
  }

  send(
    caller: StructuredAgentSessionCaller,
    params: {
      envelope: AgentSessionMutationEnvelope
      body: AgentJournalMessageItem
      retryUnknown?: true
      beforeRun?: () => void
    }
  ): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
    return this.mutate(caller, params.envelope, sendPlan(params))
  }

  cancel(
    caller: StructuredAgentSessionCaller,
    params: { envelope: AgentSessionMutationEnvelope; turnId: string }
  ): Promise<AgentSessionMutationResult<AgentSessionCancelResult>> {
    return this.mutate(caller, params.envelope, cancelPlan(params))
  }

  respondToPrompt(
    caller: StructuredAgentSessionCaller,
    params: {
      envelope: AgentSessionMutationEnvelope
      kind: 'approval' | 'question'
      itemId: string
      expectedRevision: number
      optionId: string
    }
  ): Promise<AgentSessionMutationResult<AgentSessionPromptResult>> {
    return this.mutate(caller, params.envelope, promptPlan(params))
  }

  setOption(
    caller: StructuredAgentSessionCaller,
    params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
  ): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
    return this.mutate(caller, params.envelope, setOptionPlan(params))
  }

  readOptions(sessionId: string): Promise<AgentSessionOptionsResult> {
    return this.serialize(sessionId, async () => {
      const session = this.requireSession(sessionId)
      if (!this.deps.adapter.readOptions) {
        throw new Error('structured_agent_session_options_unsupported')
      }
      return this.deps.adapter.readOptions({ sessionId, fence: session.fence })
    })
  }

  private mutate<TValue>(
    caller: StructuredAgentSessionCaller,
    envelope: AgentSessionMutationEnvelope,
    plan: MutationPlan<TValue>
  ): Promise<AgentSessionMutationResult<TValue>> {
    return this.serialize(envelope.sessionId, () =>
      admitAndRunAgentSessionMutation({
        store: this.deps.store,
        adapter: this.deps.adapter,
        callerKey: caller.callerKey,
        envelope,
        plan,
        journal: this.sessions.get(envelope.sessionId)?.journal,
        publish: (journal) => this.subscribers.publish(envelope.sessionId, journal),
        now: () => this.now()
      })
    )
  }

  requestHandoff(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionHandoffRequest
  ): Promise<AgentSessionMutationResult<AgentSessionHandoffResult>> {
    this.requireSession(params.envelope.sessionId)
    return this.serialize(params.envelope.sessionId, () =>
      this.handoffs.request(caller.callerKey, params)
    )
  }

  async handoffStatus(sessionId: string): Promise<AgentSessionHandoffStatus> {
    this.requireSession(sessionId)
    return this.serialize(sessionId, () =>
      refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
    )
  }

  history(request: AgentSessionHistoryRequest): AgentSessionHistoryResult {
    return readStructuredAgentSessionHistoryResult({
      journal: this.requireSession(request.sessionId).journal,
      record: this.deps.store.getRecord(request.sessionId),
      request
    })
  }

  subscribe(input: AgentSessionSubscribeInput): () => void {
    const session = this.requireSession(input.sessionId)
    const fence = this.deps.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 0
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence,
      handoff: this.handoffs.status(input.sessionId)
    })
  }

  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  private requireSession(sessionId: string): StructuredAgentSessionHostSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return session
  }
}
