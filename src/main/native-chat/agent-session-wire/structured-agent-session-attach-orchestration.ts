import type { StructuredRewindRecoveryEvidence } from './structured-rewind-recovery'
import {
  publishAttachedChild,
  readBoundChildRewind,
  type AttachCandidate,
  type BoundAttach
} from './structured-agent-session-attach-publish'
// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { randomUUID } from 'node:crypto'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
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
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import {
  isStructuredAgentSessionStartupExpired,
  type StructuredAgentSessionStartupAttempt
} from './structured-agent-session-startup-attempt-contract'
import {
  addAgentSessionCreatePhaseAttributes,
  withAgentSessionCreatePhase,
  withAgentSessionSpan,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'
import {
  heldStructuredAgentSessionAttachLock,
  type StructuredAgentSessionAttachLock
} from './structured-agent-session-attach-lock'

export type StructuredAgentSessionAttachOptions = {
  hostLaunchDirectory?: string
  /** The saved list a new chat's options are admitted against, for the folder its picker read. */
  catalogModels?: AttachFlowInput['models']
  recordPhase?: AgentSessionCreatePhaseRecorder
  onAcquisitionFailed?: AttachFlowInput['onAcquisitionFailed']
  /** The queued message a start is for; see `StructuredAgentSessionProviderChild.startedFor`. */
  startedFor?: string
  startupOptions?: Readonly<Record<string, string>>
  /** A close, an admitted Stop or quit aborted this attach: its refusal is that abort's. */
  onAborted?: () => void
  /** The startup limit aborted this attach's acquire: it failed, nobody stopped it. */
  onStartupExpired?: () => void
  /** An agent start's: its steps run outside the session's serialize and commit under it. */
  lock?: StructuredAgentSessionAttachLock
  startupAttemptId?: string
  /** The attach made its child the session's. */
  onPublished?: () => void
}

/** The attach an agent start runs under its own lock (`structured-agent-session-start-flight`);
 *  `attachStructuredAgentSession` runs the same steps inside one `serialize`, for a client. */
export function attachStructuredAgentSessionForStart(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions & { lock: StructuredAgentSessionAttachLock }
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return runAttach(context, callerKey, params, options)
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
      (async () => {
        for (;;) {
          const selected = await context.serialize(sessionId, async () => {
            const child = context.sessions.get(sessionId)?.child
            const flight = context.runtimeState.startFlights.get(sessionId)
            // The owning flight alone publishes its acquisition; replay waits outside its lane.
            if (!child && flight) {
              return { flight }
            }
            const record = context.deps.store.getRecord(sessionId)
            if (!child && record && agentSessionLeaseAdmitsWriter(record.lease)) {
              return {
                result: {
                  ok: false as const,
                  refusal: refuse(
                    'agent_session_ownership_unknown',
                    { reason: 'noProviderChild' },
                    'The session has no provider child to write to.'
                  )
                }
              }
            }
            return {
              result: await runAttach(context, callerKey, params, { ...options, recordPhase })
            }
          })
          if (selected.result !== undefined) {
            return selected.result
          }
          await selected.flight.outcome
        }
      })(),
      { sessionId, location: params.location }
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
  // Begun first, so a close or Stop during any phase below still stops the start. A start's lock
  // carries the controller it registered before its first wait.
  const acquire = options.lock
    ? null
    : context.runtimeState.acquireAborts.begin(params.envelope.sessionId)
  const lock = options.lock ?? heldStructuredAgentSessionAttachLock(acquire?.signal)
  try {
    return await runAttachUnderAbort(context, callerKey, params, options, lock)
  } finally {
    acquire?.end()
    if (isStructuredAgentSessionStartupExpired(lock.signal.reason)) {
      options.onStartupExpired?.()
    } else if (lock.signal.aborted) {
      options.onAborted?.()
    }
  }
}

async function runAttachUnderAbort(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions,
  lock: StructuredAgentSessionAttachLock
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const recordPhase = options.recordPhase
  // Readers of a conversation already open are re-baselined when this attach moves its fence.
  const fenceBefore = context.sessions.has(sessionId)
    ? structuredAgentSessionConversationFence(context.deps.store, sessionId)
    : null
  // Each verdict commits in the store's own transaction, against the owner identity it probed.
  const unreconciled = await withAgentSessionCreatePhase('reconcile_leases', recordPhase, () =>
    lock.wait(context.reconcileLeases(sessionId))
  )
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await withAgentSessionCreatePhase('resolve_recovery', recordPhase, () =>
    lock.wait(context.runtimeState.resolveRecovery(sessionId))
  )
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    lock.wait(context.runtimeState.probeOwner(sessionId))
  )
  // Read before the reserve clears it: how the previous generation ended decides how whatever it
  // left running is settled.
  const priorRecord = context.deps.store.getRecord(sessionId)
  const priorDeathEvidence = priorRecord?.lease.deathEvidence ?? null
  const launchDirectory =
    !priorRecord && isFloatingWorkspaceId(params.location.workspaceId)
      ? (options.hostLaunchDirectory ??
        (await lock.wait(
          Promise.resolve(context.deps.resolveWorkspacePath?.(params.location.workspaceId))
        )))
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
    bound: BoundAttach | null
    rewind: StructuredRewindRecoveryEvidence
  } = { candidate: null, committed: false, startup: null, bound: null, rewind: null }
  const { startupAttempts } = context.runtimeState
  try {
    const attached = await performAttach({
      models: priorRecord ? undefined : options.catalogModels,
      store: context.deps.store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      eventSink: attemptSink.sink,
      // The superseded child's writes settle into its own journal before a new child starts.
      onAcquiring: async () => {
        const barrier = await lock.wait(
          Promise.resolve(context.runtimeState.currentEventSink(sessionId)?.drained())
        )
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
        ...(await lock.wait(pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params))),
        ...(await lock.wait(pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params)))
      },
      callerKey,
      params,
      now: () => context.now(),
      recordPhase,
      acquireSignal: lock.signal,
      lock,
      ...(options.startupAttemptId ? { startupAttemptId: options.startupAttemptId } : {}),
      onStartupAttempt: (startup) => {
        attempt.startup = startup
        return startupAttempts.track(sessionId, startup)
      },
      ...(options.startupOptions ? { startupOptions: options.startupOptions } : {}),
      launchPermissionMode: async (record) =>
        (await lock.wait(structuredAgentSessionLaunchPermission(context.deps, record))) ??
        undefined,
      ...(options.onAcquisitionFailed ? { onAcquisitionFailed: options.onAcquisitionFailed } : {}),
      openConversation: async (record) => {
        const conversation = await context.openConversation(record.sessionId, { acquisition: true })
        if (!conversation) {
          throw new Error('agent_session_identity_required')
        }
        return conversation.journal
      },
      // The cleanup released the acquisition, which for a re-attach is the live child itself.
      onAcquisitionReleased: (cause, verdict) =>
        endStructuredAgentSessionReleasedChild(context, sessionId, cause, verdict),
      // The commit before the drain: stale rows settle, and the sink binds to the journal.
      onAttached: async (attached, acquisitionGeneration, owner) => {
        const fence = structuredAgentSessionConversationFence(context.deps.store, sessionId)
        const current = context.sessions.get(sessionId)?.child ?? null
        // A re-attach to a live child keeps the sink that child already writes through.
        const eventSink =
          owner === 'acquired'
            ? attemptSink
            : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        if (owner === 'acquired') {
          // Before the drain: the buffered events are the new child's, never a stale row's.
          await settleStaleStructuredAgentSessionState({
            journal: attached.journal,
            sessionId,
            fence,
            acquisitionGeneration,
            deathEvidence: priorDeathEvidence,
            replaced: context.deps.store.replacedRuntime(sessionId),
            failureTextContext: structuredAgentSessionFailureWordsContext(priorRecord)
          })
        }
        eventSink.bind({
          journal: attached.journal,
          fence,
          publish: (activity) => context.subscribers.publish(sessionId, attached.journal, activity)
        })
        const { journal } = attached
        attempt.bound = { acquisitionGeneration, owner, fence, journal, current, eventSink }
      },
      // Outside the commits: the barrier the host publishes behind, and for a proven child the
      // provider's word on a rewind in doubt (a starting one recovers in its open step).
      beforePublish: async (owner) => {
        const barrier = await attempt.bound?.eventSink.drained()
        if (barrier && !barrier.ok) {
          throw barrier.error
        }
        if (owner === 'kept' && attempt.bound?.current?.phase === 'ready') {
          attempt.rewind = await readBoundChildRewind(context, sessionId, attempt.bound)
        }
      },
      onPublish: async (attached, recordOutcome) => {
        const published = await publishAttachedChild(context, sessionId, attached, {
          bound: attempt.bound,
          attempt,
          attemptSink,
          fenceBefore,
          startedFor: options.startedFor,
          recordOutcome
        })
        if (published) {
          options.onPublished?.()
        }
      }
    })
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
