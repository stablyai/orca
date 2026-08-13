// Structured agent-session host: where the lease, journal, and provider adapter meet.

import { randomUUID } from 'node:crypto'
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
import { readAgentSessionHistory } from './agent-session-history-page'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import {
  admitAndRunAgentSessionMutation,
  AGENT_SESSION_NOT_ATTACHED,
  refuseAgentSessionMutation
} from './structured-agent-session-mutation-admission'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type AgentSessionSendPlanParams,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerRouting from './structured-agent-session-provider-routing'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createStructuredAgentSessionHostHandoff,
  refreshRecoverableStructuredHandoffStatus,
  type StructuredAgentSessionHostHandoff
} from './structured-agent-session-host-handoff'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
export type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps
} from './structured-agent-session-host-types'

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
          ? this.tasks.serialize(record.sessionId, () =>
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
      serialize: (sessionId, task) => this.tasks.serialize(sessionId, task),
      subscribers: this.subscribers,
      now: this.now
    })
    this.readableRestorer = new StructuredAgentSessionReadableRestorer({
      store: deps.store,
      journalRoot: deps.journalRoot,
      supportsRecord: (record) =>
        providerRouting.adapterSupportsAgentSessionRecord(deps.adapter, record),
      reconcile: this.reconcileLeases,
      resume: (params) =>
        this.attach({ callerKey: 'trusted-local:host-restart' }, params).then(
          (result) => result.ok
        ),
      serialize: (sessionId, task) => this.tasks.serialize(sessionId, task),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      onReadable: (sessionId, restored) => this.sessions.set(sessionId, restored),
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId),
      now: this.now
    })
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)

  supportsCreate(location: AgentSessionExecutionLocation, agent: string): boolean {
    return providerRouting.adapterSupportsAgentSessionCreate(this.deps.adapter, location, agent)
  }

  listSessionTabs(): providerRouting.StructuredAgentSessionTab[] {
    return [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: providerRouting.structuredAgentSessionTabAgent(session.params.agent)
    }))
  }

  restoreReadableSessions(): Promise<void> {
    return this.restartRestore.run(() => this.readableRestorer.restore())
  }

  private restoreRenewedHandoff(sessionId: string): Promise<void> {
    return this.tasks.serialize(sessionId, async () => {
      if (this.sessions.has(sessionId)) {
        await refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
      }
    })
  }

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
    const attaching = this.tasks.serialize(params.envelope.sessionId, async () => {
      const sessionId = params.envelope.sessionId
      const unreconciled = await this.reconcileLeases(sessionId)
      if (unreconciled) {
        return refuseAgentSessionMutation(unreconciled)
      }
      const eventSink = this.runtimeState.eventSinkFor(sessionId)
      const attached = await performAttach({
        store: this.deps.store,
        adapter: this.deps.adapter,
        journalRoot: this.deps.journalRoot,
        eventSink: eventSink.sink,
        onAcquiring: () => eventSink.unbind(),
        beforeJournalOpen: async () => {
          eventSink.unbind()
          await eventSink.drained()
        },
        authority: {
          spawnToken: this.deps.mintSpawnToken?.() ?? randomUUID(),
          claimKeyId: this.deps.claimKeyId,
          handoffOperationId: params.envelope.clientOperationId,
          probe: await this.runtimeState.probeOwner(sessionId),
          ...(this.deps.resolveLaunchEnv
            ? { launchEnv: this.deps.resolveLaunchEnv(params.provider) }
            : {})
        },
        callerKey: caller.callerKey,
        params,
        now: () => this.now(),
        onAttached: (attached) => {
          const fence = this.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
          const previousFence = this.sessions.get(sessionId)?.fence
          this.sessions.set(sessionId, { journal: attached.journal, params, fence })
          if (attached.recovery) {
            this.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
          } else if (previousFence !== undefined && previousFence !== fence) {
            this.subscribers.snapshot(sessionId, attached.journal, fence)
          } else {
            this.subscribers.publish(sessionId, attached.journal)
          }
          eventSink.bind({
            journal: attached.journal,
            fence,
            publish: () => this.subscribers.publish(sessionId, attached.journal)
          })
        }
      })
      if (!attached.ok && !this.sessions.has(sessionId)) {
        eventSink.close()
        this.runtimeState.discardEventSink(sessionId)
      }
      return attached
    })
    return this.tasks.trackAttach(attaching)
  }

  flushStreamedEvents(sessionId: string): Promise<void> {
    return this.runtimeState.flushEventSink(sessionId)
  }

  async flushAllStreamedEvents(): Promise<void> {
    this.runtimeState.stopLeaseRenewal()
    this.handoffs.stopTuiHistoryCatchup()
    await this.tasks.drainAttaches()
    await this.runtimeState.flushAllEventSinks()
  }

  send(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionSendPlanParams
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
    return this.tasks.serialize(sessionId, async () => {
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
    return this.tasks.serialize(envelope.sessionId, () =>
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
    return this.tasks.serialize(params.envelope.sessionId, () =>
      this.handoffs.request(caller.callerKey, params)
    )
  }

  async handoffStatus(sessionId: string): Promise<AgentSessionHandoffStatus> {
    this.requireSession(sessionId)
    return this.tasks.serialize(sessionId, () =>
      refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
    )
  }

  history(request: AgentSessionHistoryRequest): AgentSessionHistoryResult {
    const result = readAgentSessionHistory(this.requireSession(request.sessionId).journal, request)
    const fence = this.deps.store.getRecord(request.sessionId)?.lease.runtimeFence
    if (fence === undefined) {
      return result
    }
    return result.ok ? { ...result, page: { ...result.page, fence } } : { ...result, fence }
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
