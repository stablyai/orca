import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type * as SessionWire from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import { createStructuredAgentSessionHostRestore } from './structured-agent-session-reveal'
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
  resumeStructuredAgentSessionForHold,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHolds,
  StructuredAgentSessionHoldOptions
} from './structured-agent-session-holds'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'
import {
  cancelStructuredAgentSessionTurn,
  readStructuredAgentSessionOptions,
  respondToStructuredAgentSessionPrompt,
  setStructuredAgentSessionOption,
  settleStructuredAgentSessionLateDispatch,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import {
  structuredAgentSessionHostTeardownPhases,
  tearDownStructuredAgentSessionHost
} from './structured-agent-session-host-teardown'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = new Map<string, StructuredAgentSessionHostSession>()
  private readonly statusFeed = new StructuredAgentSessionStatusFeed({
    sessions: this.sessions,
    getRecord: (sessionId) => this.deps.store.getRecord(sessionId),
    now: () => this.now(),
    onStatusChanged: (summary, options) => this.deps.onSessionStatusChanged?.(summary, options)
  })
  private readonly subscribers = new AgentSessionSubscribers({
    readCommands: (sessionId) => this.deps.adapter.readCommands?.(sessionId),
    onJournalPublished: (sessionId, journal) => this.statusFeed.publish(sessionId, journal)
  })
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: (
    sessionId: string
  ) => Promise<SessionWire.AgentSessionWireRefusal | null>
  private readonly handoffs: StructuredAgentSessionHostHandoff
  private readonly restore: ReturnType<typeof createStructuredAgentSessionHostRestore>
  private readonly holds: StructuredAgentSessionHolds
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: StructuredAgentSessionBackgroundTaskChannel

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    this.backgroundTasks = new StructuredAgentSessionBackgroundTaskChannel(
      deps,
      this.sessions,
      this.subscribers,
      (sessionId) => this.requireSession(sessionId),
      (sessionId) => this.handoffs.status(sessionId)
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      (record) => this.restoreRenewedHandoff(record.sessionId),
      (record, probe) =>
        this.sessions.has(record.sessionId)
          ? this.serialize(record.sessionId, () =>
              this.handoffs.recoverDeadTuiOwner(record.sessionId, record.lease.runtimeFence, probe)
            )
          : Promise.resolve(),
      (sessionId, error) => this.eventRecovery.recoverAfterSinkFailure(sessionId, error)
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.now()
    })
    this.handoffs = createStructuredAgentSessionHostHandoff(deps, {
      session: (sessionId) => this.requireSession(sessionId),
      findSession: (sessionId) => this.sessions.get(sessionId),
      eventSink: (sessionId) => this.runtimeState.eventSinkFor(sessionId),
      flush: (sessionId) => this.flushStreamedEvents(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      subscribers: this.subscribers,
      now: this.now
    })
    this.holds = createStructuredAgentSessionHolds(this.lifetimeContext(), {
      resume: (sessionId) =>
        resumeStructuredAgentSessionForHold(
          { ...this.lifetimeContext(), reconcileLeases: this.reconcileLeases },
          sessionId,
          (params) => this.attach({ callerKey: 'trusted-local:surface-hold' }, params)
        ),
      evict: (sessionId) => this.close(sessionId)
    })
    this.restore = createStructuredAgentSessionHostRestore(deps, this.sessions, () => this.now(), {
      reconcile: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: this.hasSession,
      // Site 10: cannot overwrite a live entry — the restorer returns early on
      // `hasSession` inside the same serialized step as this `set`.
      onReadable: (sessionId, restored) => {
        this.sessions.set(sessionId, restored)
        this.statusFeed.publish(sessionId, undefined, { replay: true })
      },
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId)
    })
    this.eventRecovery = new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: this.sessions,
      flushLifecycle: (sessionId) => this.runtimeState.lifecycleBarrier(sessionId),
      publishFence: (sessionId, session) =>
        this.subscribers.snapshot(sessionId, session.journal, session.fence),
      hasResumeCapableHolder: (sessionId) => this.holds.hasResumeCapableHolder(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now(),
      attachContext: () => this.attachContext(),
      onBarrierError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error })
    })
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  isHeld = (sessionId: string): boolean => this.holds.isHeld(sessionId)

  /** A surface bound to this session and wants it live. The FIRST hold on a session with no
   *  provider child is what resumes one; a retained hold (a subscription) only keeps it. */
  hold = (
    sessionId: string,
    holderId: string,
    options?: StructuredAgentSessionHoldOptions
  ): Promise<void> => this.holds.hold(sessionId, holderId, options)

  /** That surface is gone. The child outlives it by the release grace, and by any running turn. */
  release = (sessionId: string, holderId: string): void => this.holds.release(sessionId, holderId)

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

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
      ...this.lifetimeContext(),
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task)
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

  listSessionTabs = () => listStructuredAgentSessionTabs(this.sessions)

  getPersistedVisibleSessionTabIndex(): { present: boolean; sessionIds: string[] } {
    return this.deps.store.getVisibleSessionTabIndex()
  }

  setSessionTabVisibility(sessionId: string, visible: boolean): Promise<void> {
    return this.deps.store.setSessionTabVisibility(sessionId, visible)
  }

  reconcileRestartLeases = async (): Promise<void> => {
    const refusal = await this.reconcileLeases('startup')
    if (refusal) {
      throw new Error(refusal.code)
    }
  }

  restoreReadableSessions = (sessionIds?: readonly string[]): Promise<void> =>
    this.restore.restoreReadableSessions(sessionIds)

  /** Make one persisted session addressable again; see `structured-agent-session-reveal`. */
  revealSession = (sessionId: string): Promise<StructuredAgentSessionReveal> =>
    this.restore.revealSession(sessionId)

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
  ): Promise<SessionWire.AgentSessionMutationResult<SessionWire.AgentSessionAttachResult>> {
    return attachStructuredAgentSession(this.attachContext(), caller.callerKey, params)
  }

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  async flushAllStreamedEvents(): Promise<void> {
    await tearDownStructuredAgentSessionHost({
      phases: structuredAgentSessionHostTeardownPhases({
        holds: this.holds,
        runtimeState: this.runtimeState,
        handoffs: this.handoffs,
        tasks: this.tasks
      }),
      sessions: this.sessions
    })
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

  send = (...args: Parameters<StructuredConversationCommandController['send']>) =>
    this.conversationCommands.send(...args)

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

  requestHandoff = (
    caller: StructuredAgentSessionCaller,
    params: SessionWire.AgentSessionHandoffRequest
  ): Promise<SessionWire.AgentSessionMutationResult<SessionWire.AgentSessionHandoffResult>> =>
    this.handoffs.request(caller.callerKey, params)

  readOptions = (sessionId: string): Promise<SessionWire.AgentSessionOptionsResult> =>
    readStructuredAgentSessionOptions(this.mutationContext(), sessionId)

  conversationCommand = (...args: Parameters<StructuredConversationCommandController['run']>) =>
    this.conversationCommands.run(...args)
  conversationReplacements = () => this.conversationCommands.replacements()
  /** Undefined means unavailable; an empty array is an authoritative catalog. */
  readCommands = (sessionId: string): SessionWire.AgentSessionCommandsResult => ({
    commands: this.deps.adapter.readCommands?.(sessionId)
  })

  async handoffStatus(sessionId: string): Promise<SessionWire.AgentSessionHandoffStatus> {
    this.requireSession(sessionId)
    return this.serialize(sessionId, () =>
      refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
    )
  }

  history: StructuredAgentSessionBackgroundTaskChannel['history'] = (request) =>
    this.backgroundTasks.history(request)

  /** The fully reduced timeline, for readers that cannot tolerate a page's ambiguity — a settled
   *  turn is tombstoned, so an item's ABSENCE from a bounded page proves nothing. */
  journalSnapshot = (sessionId: string): AgentJournalSnapshot =>
    this.requireSession(sessionId).journal.snapshot()

  subscribe = (input: AgentSessionSubscribeInput): (() => void) =>
    this.backgroundTasks.subscribe(input)

  settleLateDispatch = (input: Parameters<typeof settleStructuredAgentSessionLateDispatch>[1]) =>
    settleStructuredAgentSessionLateDispatch(this.mutationContext(), input)

  publishBackgroundTaskState: StructuredAgentSessionBackgroundTaskChannel['publish'] = (...args) =>
    this.backgroundTasks.publish(...args)
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  /** Every session's projected status for session lists; unlike `subscribe`, retains nothing. */
  subscribeStatus: StructuredAgentSessionStatusFeed['subscribe'] = (subscriber) =>
    this.statusFeed.subscribe(subscriber)

  private requireSession(sessionId: string): StructuredAgentSessionHostSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return session
  }
}
