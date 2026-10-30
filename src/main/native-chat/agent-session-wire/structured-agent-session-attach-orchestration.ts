import {
  publishAttachedChild,
  readBoundChildRewind,
  type AttachAttempt
} from './structured-agent-session-attach-publish'

import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { randomUUID } from 'node:crypto'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { endStructuredAgentSessionReleasedChild } from './structured-agent-session-attach-failure'
import { stampFailedCreateOwnerVerdict } from './structured-agent-session-failed-create-refusal'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type {
  StructuredAgentSessionAttachContext,
  StructuredAgentSessionAttachOptions
} from './structured-agent-session-attach-context'
export type { StructuredAgentSessionAttachOptions } from './structured-agent-session-attach-context'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionAttachPermission } from './structured-agent-session-launch-permission'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt-contract'
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
  // Track from enqueue so quit drains queued attaches before eviction, preventing late orphan spawns.
  const run = (recordPhase?: AgentSessionCreatePhaseRecorder) =>
    context.tasks.trackAttach(
      (async () => {
        for (;;) {
          const selected = await context.serialize(sessionId, async () => {
            const child = context.sessions.get(sessionId)?.child
            const flight = context.runtimeState.startFlights.get(sessionId)
            // Only the owning flight publishes; replays wait outside the lane.
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
  // Register cancellation before any phase; background-start locks already registered their controller.
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
  // Moving the fence requires rebaselining existing readers.
  const fenceBefore = context.sessions.has(sessionId)
    ? structuredAgentSessionConversationFence(context.deps.store, sessionId)
    : null
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
  // Capture prior death evidence before reservation clears it; stale-work settlement needs the verdict.
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
  // Attempt sinks become session-owned only on successful attach; failures close their buffered writes.
  const attemptSink = context.runtimeState.mintEventSink(sessionId)
  const attempt: AttachAttempt = {
    candidate: null,
    committed: false,
    startup: null,
    bound: null,
    rewind: null,
    catalogSource: context.deps.modelCatalog?.captureSource?.({
      provider: params.agent,
      location: params.location
    })
  }
  const { startupAttempts } = context.runtimeState
  try {
    const attached = await performAttach({
      models: priorRecord ? undefined : options.catalogModels,
      store: context.deps.store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      eventSink: attemptSink.sink,
      // Drain superseded writes before starting a new child.
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
        const record = context.deps.store.getRecord(sessionId)
        if (record) {
          attempt.catalogSource?.bind?.(record)
        }
        attempt.startup = startup
        return startupAttempts.track(sessionId, startup)
      },
      ...(options.startupOptions ? { startupOptions: options.startupOptions } : {}),
      launchPermissionMode: structuredAgentSessionAttachPermission(context, options, lock),
      assertNoTerminalWriter: async (record) => {
        await lock.wait(Promise.resolve(context.deps.assertNoTerminalWriter?.(record)))
      },
      ...(options.onAcquisitionFailed ? { onAcquisitionFailed: options.onAcquisitionFailed } : {}),
      openConversation: async (record) => {
        const conversation = await context.openConversation(record.sessionId, { acquisition: true })
        if (!conversation) {
          throw new Error('agent_session_identity_required')
        }
        return conversation.journal
      },
      onAcquisitionReleased: (cause, verdict) =>
        endStructuredAgentSessionReleasedChild(context, sessionId, cause, verdict),
      onAttached: async (attached, acquisitionGeneration, owner) => {
        const fence = structuredAgentSessionConversationFence(context.deps.store, sessionId)
        const current = context.sessions.get(sessionId)?.child ?? null
        // Reattach preserves the live child’s existing sink.
        const eventSink =
          owner === 'acquired'
            ? attemptSink
            : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        if (owner === 'acquired') {
          // Sweep old work before draining the new child’s buffered events.
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
      // Drain outside commits; proven children also resolve uncertain rewinds before publication.
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
      attempt.catalogSource?.release?.()
      attemptSink.close()
      if (attempt.startup) {
        startupAttempts.abandon(sessionId, attempt.startup.attemptId)
      }
    }
  }
}
