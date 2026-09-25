import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type * as SessionWire from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import { createStructuredAgentSessionHostRestore } from './structured-agent-session-reveal'
import { structuredAgentSessionOwnerStatus } from './structured-agent-session-owner-status'
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
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import * as sessionTabs from './structured-agent-session-host-tabs'
import {
  structuredAgentSessionMutationDelegates,
  settleStructuredAgentSessionLateDispatch,
  type StructuredAgentSessionMutationContext,
  releaseStructuredAgentSessionUnansweredDispatches
} from './structured-agent-session-host-mutations'
import { flushStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed'
import type { StructuredAgentSessionTurnCompletionSubscriber } from './structured-agent-session-turn-completion-feed'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import {
  createStructuredAgentSessionRestartResume,
  type StructuredAgentSessionRestartResume
} from './structured-agent-session-restart-resume-host'
import { structuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = new Map<string, StructuredAgentSessionHostSession>()
  private readonly clientDelivery = new StructuredAgentSessionClientDelivery(
    this.sessions,
    () => this.now(),
    () => this.deps,
    (sessionId) => this.holds.renew(sessionId)
  )
  private readonly subscribers = this.clientDelivery.subscribers
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: (
    sessionId: string
  ) => Promise<SessionWire.AgentSessionWireRefusal | null>
  private readonly restore: ReturnType<typeof createStructuredAgentSessionHostRestore>
  private readonly holds: StructuredAgentSessionHolds
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: StructuredAgentSessionBackgroundTaskChannel
  /** Public because the RPC surface addresses it directly; see the restart-resume collaborator. */
  readonly restartResume: StructuredAgentSessionRestartResume

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    this.backgroundTasks = new StructuredAgentSessionBackgroundTaskChannel(
      deps,
      this.sessions,
      this.subscribers,
      (sessionId) => this.requireSession(sessionId),
      this.clientDelivery.publishStatus
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(deps, (sessionId, error) =>
      this.eventRecovery.recoverAfterSinkFailure(sessionId, error)
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.now()
    })
    this.holds = createStructuredAgentSessionHolds(
      () => this.attachContext(),
      (sessionId) => this.close(sessionId)
    )
    this.restore = createStructuredAgentSessionHostRestore(deps, this.sessions, () => this.now(), {
      reconcile: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: this.hasSession,
      // Site 10: cannot overwrite a live entry — the restorer returns early on
      // `hasSession` inside the same serialized step as this `set`.
      onReadable: (sessionId, restored) => {
        this.sessions.set(sessionId, restored)
        this.clientDelivery.publishRestored(sessionId)
      }
    })
    this.eventRecovery = new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: this.sessions,
      flushLifecycle: (sessionId) => this.runtimeState.lifecycleBarrier(sessionId),
      publishFence: (sessionId, session) =>
        this.subscribers.snapshot(sessionId, session.journal, session.fence),
      publishStatus: this.clientDelivery.publishStatusAndSettlement,
      hasResumeCapableHolder: (sessionId) => this.holds.hasResumeCapableHolder(sessionId),
      restartReleaseGrace: (sessionId) => this.holds.renew(sessionId),
      // Tracked: a quit drains a queued restart before it evicts, so no child outlives it.
      serialize: (sessionId, task) => this.tasks.trackAttach(this.serialize(sessionId, task)),
      now: () => this.now(),
      ensureProviderChild: (id, options) => this.holds.ensureProviderChild(id, options),
      onBarrierError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error })
    })
    this.restartResume = createStructuredAgentSessionRestartResume(deps, this.sessions, {
      ...structuredAgentSessionRestartResumeSurfaces(this, this.now),
      publish: this.subscribers.publish.bind(this.subscribers)
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

  /** That surface is gone. The child outlives it by the idle window, and by any running turn. */
  release = (sessionId: string, holderId: string): void => this.holds.release(sessionId, holderId)

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  private lifetimeContext(): StructuredAgentSessionLifetimeContext {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now(),
      forgetStatus: this.clientDelivery.forgetStatus
    }
  }

  /** The host's half of attaching, named so it cannot grow dependencies unnoticed. */
  private attachContext(): StructuredAgentSessionAttachContext {
    return {
      ...this.lifetimeContext(),
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      publishStatus: this.clientDelivery.publishStatus
    }
  }
  /** Releases a session's resources without ending the conversation: the record and journal stay
   *  on disk, so the same session can be attached again. */
  close(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await evictHeldStructuredAgentSession(this.lifetimeContext(), sessionId)
      this.clientDelivery.closeSession(sessionId)
      // The holders now look at a session that is gone; a failed eviction throws above, keeping them.
      this.holds.forget(sessionId)
    })
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  listSessionTabs = () => sessionTabs.listStructuredAgentSessionTabs(this.sessions)
  getPersistedVisibleSessionTabIndex = () => this.deps.store.getVisibleSessionTabIndex()

  setSessionTabVisibility = (sessionId: string, visible: boolean): Promise<void> =>
    sessionTabs.setStructuredAgentSessionTabVisibility(this, sessionId, visible)

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

  private serialize = this.tasks.serialize.bind(this.tasks)

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ): Promise<SessionWire.AgentSessionMutationResult<SessionWire.AgentSessionAttachResult>> {
    return attachStructuredAgentSession(this.attachContext(), caller.callerKey, params)
  }

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  // Trigger inlined rather than imported: `AgentSessionResumeTrigger` in shared is the canonical
  // type, and this file has no line budget left for the import.
  async flushAllStreamedEvents(options?: { trigger?: 'quit' | 'update' }): Promise<void> {
    await flushStructuredAgentSessionHost({
      ...this.lifetimeContext(),
      holds: this.holds,
      tasks: this.tasks,
      restartResume: this.restartResume,
      serialize: this.serialize,
      trigger: options?.trigger ?? 'quit'
    }).finally(() => this.clientDelivery.closeAll())
  }

  private mutationContext(): StructuredAgentSessionMutationContext {
    return {
      deps: this.deps,
      sessions: this.sessions,
      publish: (sessionId, journal) => this.subscribers.publish(sessionId, journal),
      flushStreamedEvents: this.flushStreamedEvents,
      requireSession: (sessionId) => this.requireSession(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      holds: this.holds,
      restoreReadable: (sessionId) => this.restore.restoreReadableUnderSerialize(sessionId),
      now: () => this.now()
    }
  }

  send = this.conversationCommands.send

  waitForSendSettlement = this.clientDelivery.waitForSendSettlement

  private mutations = structuredAgentSessionMutationDelegates(() => this.mutationContext())
  cancel = this.mutations.cancel
  respondToPrompt = this.mutations.respondToPrompt
  setOption = this.mutations.setOption
  changeThreadGoal = this.mutations.changeThreadGoal
  readOptions = this.mutations.readOptions

  rewind = (caller: StructuredAgentSessionCaller, params: AgentSessionRewindParams) =>
    rewindStructuredAgentSession(this.mutationContext(), this.attachContext(), caller, params)

  conversationCommand = (...args: Parameters<StructuredConversationCommandController['run']>) =>
    this.conversationCommands.run(...args)
  conversationReplacements = () => this.conversationCommands.replacements()
  /** Undefined means unavailable; an empty array is an authoritative catalog. */
  readCommands = (sessionId: string): SessionWire.AgentSessionCommandsResult => ({
    commands: this.deps.adapter.readCommands?.(sessionId)
  })

  async handoffStatus(sessionId: string): Promise<SessionWire.AgentSessionHandoffStatus> {
    this.requireSession(sessionId)
    // Queued behind an in-flight attach, so a starting chat answers with its settled owner.
    return this.serialize(sessionId, async () => {
      const record = this.deps.store.getRecord(sessionId)
      if (!record) {
        throw new Error('agent_session_identity_required')
      }
      return structuredAgentSessionOwnerStatus(record)
    })
  }

  history: StructuredAgentSessionBackgroundTaskChannel['history'] = (request) =>
    this.backgroundTasks.history(request)

  /** The fully reduced timeline, for readers that cannot tolerate a page's ambiguity — rows are
   *  revised or tombstoned in place, so an item's ABSENCE from a bounded page proves nothing. */
  journalSnapshot = (sessionId: string): AgentJournalSnapshot =>
    this.requireSession(sessionId).journal.snapshot()

  subscribe = (input: AgentSessionSubscribeInput): (() => void) =>
    this.backgroundTasks.subscribe(input)

  settleLateDispatch = (input: Parameters<typeof settleStructuredAgentSessionLateDispatch>[1]) =>
    settleStructuredAgentSessionLateDispatch(this.mutationContext(), input)

  releaseUnansweredDispatches = (
    input: Parameters<typeof releaseStructuredAgentSessionUnansweredDispatches>[1]
  ) => releaseStructuredAgentSessionUnansweredDispatches(this.mutationContext(), input)

  publishBackgroundTaskState: StructuredAgentSessionBackgroundTaskChannel['publish'] = (...args) =>
    this.backgroundTasks.publish(...args)
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  /** Every session's projected status for session lists; unlike `subscribe`, retains nothing. */
  subscribeStatus = (subscriber: StructuredAgentSessionStatusSubscriber): (() => void) =>
    this.clientDelivery.subscribeStatus(subscriber)

  /** Turns that settle from now on. Live-only: nothing missed is replayed. */
  subscribeTurnCompletions = (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ): (() => void) => this.clientDelivery.subscribeTurnCompletions(subscriber)

  private requireSession(sessionId: string): StructuredAgentSessionHostSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
    }
    return session
  }
}
