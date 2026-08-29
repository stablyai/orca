// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationResult,
  AgentSessionOptionsResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
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
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import {
  createStructuredAgentSessionHolds,
  evictHeldStructuredAgentSession,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHolds,
  StructuredAgentSessionHoldOptions
} from './structured-agent-session-holds'
import { resumeHeldStructuredAgentSession } from './structured-agent-session-hold-resume'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'
import {
  cancelStructuredAgentSessionTurn,
  readStructuredAgentSessionOptions,
  respondToStructuredAgentSessionPrompt,
  sendStructuredAgentSessionTurn,
  setStructuredAgentSessionOption,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
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
  private readonly holds: StructuredAgentSessionHolds

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
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
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
    this.holds = createStructuredAgentSessionHolds(this.lifetimeContext(), {
      resume: (sessionId) => this.resumeForHold(sessionId),
      evict: (sessionId) => this.close(sessionId)
    })
    this.readableRestorer = new StructuredAgentSessionReadableRestorer({
      store: deps.store,
      journalRoot: deps.journalRoot,
      supportsRecord: (record) => providerSupport.adapterSupportsRecord(deps.adapter, record),
      reconcile: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      onReadable: (sessionId, restored) => this.sessions.set(sessionId, restored),
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId)
    })
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)

  /** A surface bound to this session and wants it live. The FIRST hold on a session with no
   *  provider child is what resumes one; a retained hold (a subscription) only keeps it. */
  hold = (
    sessionId: string,
    holderId: string,
    options?: StructuredAgentSessionHoldOptions
  ): Promise<void> => this.holds.hold(sessionId, holderId, options)

  /** That surface is gone. The child outlives it by the release grace, and by any running turn. */
  release = (sessionId: string, holderId: string): void => this.holds.release(sessionId, holderId)

  isHeld = (sessionId: string): boolean => this.holds.isHeld(sessionId)

  private async resumeForHold(sessionId: string): Promise<void> {
    const unreconciled = await this.reconcileLeases(sessionId)
    if (unreconciled) {
      throw new Error(unreconciled.code)
    }
    await this.runtimeState.resolveRecovery(sessionId)
    await resumeHeldStructuredAgentSession({
      sessionId,
      deps: this.deps,
      now: () => this.now(),
      attach: (params) => this.attach({ callerKey: 'trusted-local:surface-hold' }, params)
    })
  }

  private lifetimeContext(): StructuredAgentSessionLifetimeContext {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now()
    }
  }

  /** The host's half of attaching, named so it cannot grow dependencies unnoticed. */
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

  /** Releases a session's resources without ending the conversation: the record and journal stay
   *  on disk, so the same session can be attached again. */
  close(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.handoffs.closeRetainedTuiOwner(sessionId)
      await evictHeldStructuredAgentSession(this.lifetimeContext(), sessionId)
      // Whoever asked for the close, the surfaces that were holding this session are looking at a
      // session that no longer exists. A failed eviction throws above and keeps them.
      this.holds.forget(sessionId)
    })
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  listSessionTabs() {
    return listStructuredAgentSessionTabs(this.sessions)
  }

  reconcileRestartLeases = async (): Promise<void> => {
    const refusal = await this.reconcileLeases('startup')
    if (refusal) {
      throw new Error(refusal.code)
    }
  }

  restoreReadableSessions = (sessionIds?: readonly string[]): Promise<void> =>
    this.restartRestore.run(() => this.readableRestorer.restore(sessionIds))

  private serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> =>
    this.tasks.serialize(sessionId, task)

  private restoreRenewedHandoff(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (this.sessions.has(sessionId)) {
        await refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
      }
    })
  }

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
    return attachStructuredAgentSession(this.attachContext(), caller.callerKey, params)
  }

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  async flushAllStreamedEvents(): Promise<void> {
    this.holds.dispose()
    this.runtimeState.stopLeaseRenewal()
    this.handoffs.stopTuiHistoryCatchup()
    await this.tasks.drainAttaches()
    await this.runtimeState.flushAllEventSinks()
  }

  private mutationContext(): StructuredAgentSessionMutationContext {
    return {
      deps: this.deps,
      sessions: this.sessions,
      publish: (sessionId, journal) => this.subscribers.publish(sessionId, journal),
      requireSession: (sessionId) => this.requireSession(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    }
  }

  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> =>
    sendStructuredAgentSessionTurn(this.mutationContext(), caller, params)

  cancel = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof cancelStructuredAgentSessionTurn> =>
    cancelStructuredAgentSessionTurn(this.mutationContext(), caller, params)

  respondToPrompt = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
  ): ReturnType<typeof respondToStructuredAgentSessionPrompt> =>
    respondToStructuredAgentSessionPrompt(this.mutationContext(), caller, params)

  setOption = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof setStructuredAgentSessionOption>[2]
  ): ReturnType<typeof setStructuredAgentSessionOption> =>
    setStructuredAgentSessionOption(this.mutationContext(), caller, params)

  readOptions = (sessionId: string): Promise<AgentSessionOptionsResult> =>
    readStructuredAgentSessionOptions(this.mutationContext(), sessionId)

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
