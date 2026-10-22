// The attach's last commit: the child it spawned or kept becomes the session's, its sink the one
// the session's events go through, and its open begins.

import type { AttachedJournal } from './structured-agent-session-attach'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AttachedOwner } from './structured-agent-session-attach-flow'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { indexProviderChild } from './structured-agent-session-provider-child'
import { noteStructuredAgentSessionProviderStarted } from './structured-agent-session-provider-started'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'
import { structuredAgentSessionEndedEventExit } from './structured-agent-session-child-exit'
import {
  applyStructuredRewindRecovery,
  readStructuredRewindRecovery,
  type StructuredRewindRecoveryEvidence
} from './structured-rewind-recovery'

export type AttachCandidate = {
  child: StructuredAgentSessionProviderChild
  sink: DeferredStructuredAgentSessionEventSink
}

export type BoundAttach = {
  acquisitionGeneration: string | null
  owner: AttachedOwner
  fence: number
  journal: AgentSessionJournal
  current: StructuredAgentSessionProviderChild | null
  eventSink: DeferredStructuredAgentSessionEventSink
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

/** The attach's last commit: its child, if it has one, becomes the session's. */
export async function publishAttachedChild(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  attached: AttachedJournal,
  input: {
    bound: BoundAttach | null
    attempt: {
      candidate: AttachCandidate | null
      committed: boolean
      startup: StructuredAgentSessionStartupAttempt | null
      rewind: StructuredRewindRecoveryEvidence
    }
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
  // A re-attach to a live child keeps the mode that child was launched with.
  const permissionMode =
    owner === 'acquired' ? attempt.startup?.permissionMode : current?.permissionMode
  const startedFor = owner === 'acquired' ? input.startedFor : current?.startedFor
  // A replayed create over a chat at rest has no child to index.
  const child =
    owner === 'acquired'
      ? {
          generation: acquisitionGeneration,
          fence,
          phase: 'starting' as const,
          heldSends: () => context.deps.adapter.heldSends?.(sessionId),
          exitObservation: eventSink.exitObservation,
          ...(startedFor === undefined ? {} : { startedFor }),
          ...(permissionMode === undefined ? {} : { permissionMode })
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
  // An exit that landed while the start ran outside the serialize ends the child it now indexed.
  const exited = context.runtimeState.startFlights.takeExit(sessionId, candidate.child)
  const indexed = conversation.child
  if (exited && indexed) {
    await context.endExitedChild(sessionId, indexed, structuredAgentSessionEndedEventExit(exited))
  } else if (attempt.startup) {
    context.runtimeState.startupAttempts.published(
      sessionId,
      attempt.startup.attemptId,
      candidate.child
    )
    if (candidate.child.phase === 'ready') {
      noteStructuredAgentSessionProviderStarted(context.deps, sessionId)
    } else {
      context.openProviderChild?.(sessionId, candidate.child)
    }
  }
  context.publishStatus?.(sessionId)
  return true
}
