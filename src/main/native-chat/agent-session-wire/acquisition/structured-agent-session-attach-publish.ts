import type { AgentModelCatalogSource } from '../../agent-model-catalog/agent-model-catalog-service-contract'
// The attach's last commit: the child it spawned or kept becomes the session's, its sink the one
// the session's events go through, and its open begins.

import type { AttachedJournal } from './structured-agent-session-attach'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { AttachedOwner } from './structured-agent-session-attach-flow'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { DeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import { indexProviderChild } from '../host/structured-agent-session-provider-child'
import { noteStructuredAgentSessionProviderStarted } from '../startup/structured-agent-session-provider-started'
import type { StructuredAgentSessionStartupAttempt } from '../startup/structured-agent-session-startup-attempt-contract'
import '../termination/structured-agent-session-child-exit'
import { structuredAgentSessionEndedEventExit } from '../termination/structured-agent-session-child-exit-record'
import {
  applyStructuredRewindRecovery,
  readStructuredRewindRecovery,
  type StructuredRewindRecoveryEvidence
} from '../rewind/structured-rewind-recovery'

export type AttachCandidate = {
  child: StructuredAgentSessionProviderChild
  sink: DeferredStructuredAgentSessionEventSink
}

export type BoundAttach = {
  acquisitionGeneration: string | null
  /** The account home the spawned child launched under, when its adapter reports one. */
  accountHome?: AgentSessionAccountHome
  owner: AttachedOwner
  fence: number
  journal: AgentSessionJournal
  current: StructuredAgentSessionProviderChild | null
  eventSink: DeferredStructuredAgentSessionEventSink
}

export type AttachAttempt = {
  candidate: AttachCandidate | null
  committed: boolean
  catalogSource?: AgentModelCatalogSource
  startup: StructuredAgentSessionStartupAttempt | null
  bound: BoundAttach | null
  rewind: StructuredRewindRecoveryEvidence
}

/** The provider's word on a rewind in doubt for the child this attach bound, read outside the
 *  commits so no send waits behind it. */
export function readBoundChildRewind(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  bound: BoundAttach
): Promise<StructuredRewindRecoveryEvidence> {
  return readStructuredRewindRecovery(
    context.deps,
    sessionId,
    bound.journal,
    bound.fence,
    context.deps.adapter
  )
}

export async function publishAttachedChild(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  attached: AttachedJournal,
  input: {
    bound: BoundAttach | null
    attempt: AttachAttempt
    attemptSink: DeferredStructuredAgentSessionEventSink
    fenceBefore: number | null
    startedFor: string | undefined
    recordOutcome: () => Promise<void>
  }
): Promise<boolean> {
  const { attempt, bound } = input
  if (!bound) {
    await input.recordOutcome()
    return false
  }
  const { acquisitionGeneration, owner, fence, current, eventSink } = bound
  // A re-attach to a live child keeps the mode and account that child was launched with.
  const permissionMode =
    owner === 'acquired' ? attempt.startup?.permissionMode : current?.permissionMode
  const accountHome = owner === 'acquired' ? bound.accountHome : current?.accountHome
  const startedFor = owner === 'acquired' ? input.startedFor : current?.startedFor
  const child =
    owner === 'acquired'
      ? {
          generation: acquisitionGeneration,
          fence,
          phase: 'starting' as const,
          catalogSource: attempt.catalogSource,
          heldSends: () => context.deps.adapter.heldSends?.(sessionId),
          exitObservation: eventSink.exitObservation,
          ...(startedFor === undefined ? {} : { startedFor }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
          ...(accountHome === undefined ? {} : { accountHome })
        }
      : owner === 'kept' && current
        ? current
        : null
  if (child) {
    attempt.candidate = { sink: eventSink, child }
  }
  if (attempt.candidate?.child.phase === 'ready') {
    await applyStructuredRewindRecovery(
      context.deps,
      sessionId,
      attached.journal,
      fence,
      attempt.rewind
    )
  }
  if (input.fenceBefore !== null && fence !== input.fenceBefore) {
    context.subscribers.snapshot(sessionId, attached.journal, fence)
  } else {
    context.subscribers.publish(sessionId, attached.journal)
  }
  await input.recordOutcome()
  const { candidate } = attempt
  const conversation = context.sessions.get(sessionId)
  if (!candidate || !conversation) {
    return false
  }
  context.runtimeState.adoptEventSink(sessionId, candidate.sink)
  attempt.committed = candidate.sink === input.attemptSink
  indexProviderChild(conversation, candidate.child)
  context.runtimeState.startFlights.published(sessionId, candidate.child)
  if (attempt.startup) {
    context.runtimeState.startupAttempts.published(
      sessionId,
      attempt.startup.attemptId,
      candidate.child
    )
  }
  // Apply exits observed during background startup after indexing the matching child; the open
  // claims a starting child's outcome first, so the adapter answers for its own early exit.
  const exited = context.runtimeState.startFlights.takeExit(sessionId, candidate.child)
  const indexed = conversation.child
  const opens = !!attempt.startup && candidate.child.phase !== 'ready'
  if (opens) {
    context.openProviderChild?.(sessionId, candidate.child)
  }
  if (exited && indexed) {
    await context.endExitedChild(sessionId, indexed, structuredAgentSessionEndedEventExit(exited))
  } else if (attempt.startup && !opens) {
    noteStructuredAgentSessionProviderStarted(
      context.deps,
      sessionId,
      () =>
        context.sessions.get(sessionId)?.child === candidate.child &&
        candidate.child.catalogSource?.() !== false
    )
  }
  context.publishStatus?.(sessionId)
  return true
}
