import { recoverStructuredRewind } from './structured-rewind-recovery'
// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach, type AttachFlowInput } from './structured-agent-session-attach-flow'
import { endStructuredAgentSessionReleasedChild } from './structured-agent-session-attach-failure'
import { stampFailedCreateOwnerVerdict } from './structured-agent-session-failed-create-refusal'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import {
  indexProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { noteStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'
import {
  addAgentSessionCreatePhaseAttributes,
  withAgentSessionCreatePhase,
  withAgentSessionSpan,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'

export type StructuredAgentSessionAttachOptions = {
  hostLaunchDirectory?: string
  recordPhase?: AgentSessionCreatePhaseRecorder
  onAcquisitionFailed?: AttachFlowInput['onAcquisitionFailed']
  /** The queued message a start is for; see `StructuredAgentSessionProviderChild.startedFor`. */
  startedFor?: string
  /** A close, an admitted Stop or quit aborted this attach: its refusal is that abort's. */
  onAborted?: () => void
  /** The startup limit aborted this attach's acquire: it failed, nobody stopped it. */
  onStartupExpired?: () => void
}

/**
 * The attach itself, for a caller already inside the session's serialize.
 *
 * That is every caller that has to know what the session looks like RIGHT NOW: the delivery loop,
 * and an operation that needs the provider. They run their check and this attach in one serialized
 * step, so "the session has no child" is still true when
 * the attach starts. `attachStructuredAgentSession` is this under `serialize`, for a client.
 */
export function attachStructuredAgentSessionUnderSerialize(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(runAttach(context, callerKey, params, options))
}

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  // Tracked from enqueue, not from its turn on the queue: a quit drains a queued attach before it
  // evicts, so no child is spawned behind the eviction and orphaned.
  const run = (recordPhase?: AgentSessionCreatePhaseRecorder) =>
    context.tasks.trackAttach(
      context.serialize(sessionId, () =>
        runAttach(context, callerKey, params, { ...options, recordPhase })
      )
    )
  if (params.envelope.expectedRuntimeFence !== null) {
    return run()
  }
  return withAgentSessionSpan(async (span) => {
    const startedAtMs = Date.now()
    const phases: Parameters<AgentSessionCreatePhaseRecorder>[0][] = []
    try {
      return await run((timing) => phases.push(timing))
    } finally {
      addAgentSessionCreatePhaseAttributes(span, {
        totalDurationMs: Math.max(0, Date.now() - startedAtMs),
        phases
      })
    }
  })
}

async function runAttach(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  // Begun first, so a close or Stop during any phase below still stops the start.
  const acquire = context.runtimeState.acquireAborts.begin(params.envelope.sessionId)
  try {
    return await runAttachUnderAbort(context, callerKey, params, options, acquire.signal)
  } finally {
    acquire.end()
    if (isStructuredAgentSessionStartupExpired(acquire.signal.reason)) {
      options.onStartupExpired?.()
    } else if (acquire.signal.aborted) {
      options.onAborted?.()
    }
  }
}

async function runAttachUnderAbort(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions,
  acquireSignal: AbortSignal
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const recordPhase = options.recordPhase
  // Readers of a conversation already open are re-baselined when this attach moves its fence.
  const fenceBefore = context.sessions.has(sessionId)
    ? structuredAgentSessionConversationFence(context.deps.store, sessionId)
    : null
  const unreconciled = await withAgentSessionCreatePhase('reconcile_leases', recordPhase, () =>
    context.reconcileLeases(sessionId)
  )
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await withAgentSessionCreatePhase('resolve_recovery', recordPhase, () =>
    context.runtimeState.resolveRecovery(sessionId)
  )
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    context.runtimeState.probeOwner(sessionId)
  )
  // Read before the reserve clears it: how the previous generation ended decides how whatever it
  // left running is settled.
  const priorRecord = context.deps.store.getRecord(sessionId)
  const priorDeathEvidence = priorRecord?.lease.deathEvidence ?? null
  const launchDirectory =
    !priorRecord && isFloatingWorkspaceId(params.location.workspaceId)
      ? (options.hostLaunchDirectory ??
        (await context.deps.resolveWorkspacePath?.(params.location.workspaceId)))
      : undefined
  if (!priorRecord && isFloatingWorkspaceId(params.location.workspaceId) && !launchDirectory) {
    throw new Error('floating_agent_session_launch_directory_unavailable')
  }
  // A child this attach spawns writes through a sink this attempt owns. Only a successful
  // attach makes the child and its sink the session's; any other exit closes the sink with
  // whatever the child queued, and leaves the conversation's child as it was.
  const attemptSink = context.runtimeState.mintEventSink(sessionId)
  const attempt: {
    candidate: AttachCandidate | null
    committed: boolean
    startup: StructuredAgentSessionStartupAttempt | null
  } = { candidate: null, committed: false, startup: null }
  const { startupAttempts } = context.runtimeState
  try {
    const attached = await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      eventSink: attemptSink.sink,
      // The superseded child's writes settle into its own journal before a new child starts.
      onAcquiring: async () => {
        const barrier = await context.runtimeState.currentEventSink(sessionId)?.drained()
        if (barrier && !barrier.ok) {
          throw barrier.error
        }
      },
      authority: {
        ...(launchDirectory ? { launchDirectory } : {}),
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe,
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      },
      callerKey,
      params,
      now: () => context.now(),
      recordPhase,
      acquireSignal,
      onStartCatalogListing: (listing) =>
        context.deps.modelCatalog?.recordLiveListing(sessionId, listing),
      onStartupAttempt: (startup) => {
        attempt.startup = startup
        return startupAttempts.track(sessionId, startup)
      },
      optionRevision: () => context.runtimeState.optionRevisions.current(sessionId),
      ...(options.onAcquisitionFailed ? { onAcquisitionFailed: options.onAcquisitionFailed } : {}),
      openConversation: async (record) => {
        const conversation = await context.openConversation(record.sessionId, {
          acquisition: true
        })
        if (!conversation) {
          throw new Error('agent_session_identity_required')
        }
        return conversation.journal
      },
      // The cleanup released the acquisition, which for a re-attach is the live child itself.
      onAcquisitionReleased: (cause, verdict) =>
        endStructuredAgentSessionReleasedChild(context, sessionId, cause, verdict),
      onAttached: async (attached, acquisitionGeneration, acquiredOwner, providerChildPhase) => {
        const fence = structuredAgentSessionConversationFence(context.deps.store, sessionId)
        const current = context.sessions.get(sessionId)?.child ?? null
        const startedFor = acquiredOwner ? options.startedFor : current?.startedFor
        // A re-attach to a live child keeps the sink that child already writes through.
        const eventSink = acquiredOwner
          ? attemptSink
          : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        if (acquiredOwner) {
          // Before the drain: the buffered events are the new child's, never a stale row's.
          await settleStaleStructuredAgentSessionState({
            journal: attached.journal,
            sessionId,
            fence,
            acquisitionGeneration,
            deathEvidence: priorDeathEvidence,
            failureTextContext: structuredAgentSessionFailureWordsContext(priorRecord)
          })
        }
        await bindAndDrain(eventSink, attached.journal, fence, (activity) =>
          context.subscribers.publish(sessionId, attached.journal, activity)
        )
        attempt.candidate = {
          sink: eventSink,
          child: {
            generation: acquisitionGeneration ?? current?.generation ?? null,
            fence,
            // A re-attach to a live child keeps what that child already proved, and its cause.
            phase: acquiredOwner ? providerChildPhase : (current?.phase ?? 'ready'),
            ...(startedFor === undefined ? {} : { startedFor })
          }
        }
        await recoverStructuredRewind(
          context.deps,
          sessionId,
          attached.journal,
          fence,
          context.deps.adapter,
          context.now
        )
        if (fenceBefore !== null && fence !== fenceBefore) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
      }
    })
    const { candidate } = attempt
    const conversation = context.sessions.get(sessionId)
    if (attached.ok && candidate && conversation) {
      context.runtimeState.adoptEventSink(sessionId, candidate.sink)
      attempt.committed = candidate.sink === attemptSink
      indexProviderChild(conversation, candidate.child)
      if (attempt.startup) {
        startupAttempts.published(sessionId, attempt.startup.attemptId, candidate.child)
        // Only an acquire proves a start; a re-attach to a live child proved nothing.
        if (candidate.child.phase === 'ready') {
          noteStructuredAgentSessionProviderStarted(context.deps, sessionId)
        }
      }
      context.publishStatus?.(sessionId)
    }
    return stampFailedCreateOwnerVerdict(context.deps.store, callerKey, params.envelope, attached)
  } finally {
    if (!attempt.committed) {
      attemptSink.close()
      if (attempt.startup) {
        startupAttempts.abandon(sessionId, attempt.startup.attemptId)
      }
    }
  }
}

type AttachCandidate = {
  child: StructuredAgentSessionProviderChild
  sink: DeferredStructuredAgentSessionEventSink
}

/** Binds the sink to the journal and waits for the barrier the host publishes
 *  behind. It throws by design when a sink barrier fails. */
async function bindAndDrain(
  eventSink: DeferredStructuredAgentSessionEventSink,
  journal: AgentSessionJournal,
  fence: number,
  publish: (activity?: AgentSessionTurnActivity | null) => void
): Promise<void> {
  eventSink.bind({ journal, fence, publish })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
