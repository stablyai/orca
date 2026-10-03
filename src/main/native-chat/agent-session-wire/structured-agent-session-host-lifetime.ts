// The host's half of a session's lifetime: stopping its agent, and closing its conversation.
//
// Two operations, because they end two different things. Stopping the agent ends the provider
// child and hands the lease back; the conversation — its open journal, its status row and its
// readers — stays, and the next send starts a new child. Closing the conversation drops its
// in-memory fold, a cache the next read or write rebuilds from the host's journal database.
//
// Both are written for a caller already inside the session's serialize: the queue is not
// reentrant, so every public entry point takes it once and calls these.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionOwedWindDown,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  endProviderChild,
  pendingProviderChildWindDown,
  sameProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionStopCause } from './structured-agent-session-adapter'
export type { StructuredAgentSessionStopEnding } from './structured-agent-session-host-stop-event'
import {
  recordStopEvent,
  stopEndsWork,
  type StructuredAgentSessionStopEnding
} from './structured-agent-session-host-stop-event'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
  /** Re-projects the session's status after its agent stopped and the chat stays. */
  publishStatus?: (sessionId: string) => void
  /** Hands the delivery loop what is queued; for a caller inside the session's serialize. */
  wakeDelivery?: (sessionId: string) => void
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'logger'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}

/** A conversation's handle closes with nothing queued: what is still queued when the chat closes,
 *  or the app quits, will not be handed over. Best effort: the next open's delivery loop rejects a
 *  leftover itself. `which` narrows it to the messages a close that did not complete closed.
 *  Resolves false when the rejection failed; the failure is reported, never thrown. */
export async function abandonQueuedStructuredAgentSessionMessages(
  deps: ConversationCloseDeps,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  which?: (submission: AgentJournalSubmission) => boolean
): Promise<boolean> {
  return journal
    .rejectQueuedSubmissions(
      structuredAgentSessionConversationFence(deps.store, sessionId),
      agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' }),
      which
    )
    .then(
      () => true,
      (error: unknown) => {
        deps.logger.warn('rejecting queued messages of a closed chat failed', {
          scope: 'queued-abandon',
          sessionId,
          error
        })
        return false
      }
    )
}

/** The wind-down this host owes for the session's child. A live child always owes one, whatever a
 *  previous childless eviction recorded: a remembered tombstone must never outrank the child in
 *  front of it. */
function owedProviderChildWindDown(
  session: StructuredAgentSessionHostSession
): StructuredAgentSessionProviderChildIdentity | undefined {
  return session.child
    ? { generation: session.child.generation, fence: session.child.fence }
    : session.owesProviderChildWindDown
}

/** The stop this pass owes. A retry continues the one already asked for, keeping where it was asked;
 *  any other stop is a new ask, even one with the same cause: a second close closes what came since. */
function owedStop(
  session: StructuredAgentSessionHostSession,
  cause: StructuredAgentSessionStopCause,
  retry: boolean
): StructuredAgentSessionOwedWindDown | undefined {
  const owed = owedProviderChildWindDown(session)
  if (!owed) {
    return undefined
  }
  const asked = session.owesProviderChildWindDown
  const continues = retry && asked !== undefined && sameProviderChild(asked, owed)
  return {
    generation: owed.generation,
    fence: owed.fence,
    cause,
    requestedAt: continues ? asked.requestedAt : session.journal.cursor()
  }
}

/**
 * The agent goes to rest; the conversation stays. Runs the eviction steps under a deadline. A step
 * that fails — or runs out of time — aborts the rest and leaves the wind-down owed, so the next
 * stop is a real retry. `ending` is how the child's end is told: a user's Stop, the host stopping it
 * for a cause (with its text), or an eviction the conversation's close follows.
 */
export async function stopStructuredAgentSessionAgentUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  ending: StructuredAgentSessionStopEnding
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  // Judged before the kill: a stop that ends nothing writes nothing.
  const recorded = (await stopEndsWork(context, sessionId, session, ending))
    ? recordStopEvent(context, sessionId, session, ending)
    : Promise.resolve(null)
  // The obligation OUTLIVES the child. `child` is ended the instant the adapter proves the exit,
  // so a step that aborts after that point would otherwise leave the retry reading "no child
  // here" and skipping the settlement and the lease release it still owes.
  const asked = 'recorded' in ending ? ending.recorded : ending.cause
  // A retry finishes the stop that ended the child, so the child's end keeps that stop's cause.
  const cause = session.child ? asked : (session.owesProviderChildWindDown?.cause ?? asked)
  const owed = owedStop(session, cause, ending.retry === true)
  session.owesProviderChildWindDown = owed
  const stopping = session.child
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    // The retry must not re-stop a child the adapter already proved gone, so this stays honest.
    hasProviderChild: stopping !== null,
    owesProviderChildWindDown: owed !== undefined,
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    logger: context.deps.logger,
    ...(context.restartWitness
      ? { beforeProviderChildStop: () => context.restartWitness?.beforeStop(sessionId) }
      : {}),
    // Host state must not disagree with the adapter for the steps in between.
    onProviderChildStopped: (verdict) => {
      if (stopping) {
        endProviderChild(session, {
          generation: stopping.generation,
          fence: stopping.fence,
          cause,
          reason: ('reason' in ending ? ending.reason : undefined) ?? null,
          duringStartup: stopping.phase === 'starting',
          // A later retry that proves the exit still ends the child at the Stop it finishes.
          ...(owed ? { endedAt: owed.requestedAt } : {}),
          ...verdict
        })
      }
      context.restartWitness?.stopped(sessionId)
    },
    acknowledgeRelease: () => context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      // Folded before the fallback's end is built, so the end reads it (`turnEndAfterStop`).
      await recorded
      const fence =
        owed?.fence ?? structuredAgentSessionConversationFence(context.deps.store, sessionId)
      const settled = await settleStructuredAgentSessionDeadGeneration({
        journal: session.journal,
        sessionId,
        fence,
        settlementId: `expected-close:${sessionId}:${fence}:${owed?.generation ?? 'unknown'}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        // Only a turn no adapter settled: one with no close, or whose settle threw. Whether it was
        // a person's Stop is its event's to say (`turnEndAfterStop`).
        verdict: { state: 'interrupted', completedAt: context.now() },
        showUnexpectedExitOutcome: false
      })
      if (!settled.ok) {
        context.deps.logger.warn("settling a closed agent's work failed", {
          scope: 'close-settlement',
          sessionId,
          error: settled.error
        })
        // Without the cause the log names the step and nothing else.
        throw new Error('dead generation work settlement failed', { cause: settled.error })
      }
    },
    releaseLease: async () => {
      if (owed) {
        await releaseStoredStructuredAgentSessionOwner({
          store: context.deps.store,
          sessionId,
          hasProviderChild: true,
          expectedFence: owed.fence,
          now: context.now()
        })
      }
      session.owesProviderChildWindDown = undefined
      // Whatever ended the child, the row belongs to the conversation: it shows not-running, and
      // only the conversation's close forgets it.
      context.publishStatus?.(sessionId)
      // The stop's own end hands over what waited on it, whichever caller's retry landed.
      context.wakeDelivery?.(sessionId)
    }
  }
  try {
    await evictStructuredAgentSession(
      eviction,
      withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
    )
  } catch (error) {
    if (session.owesProviderChildWindDown === owed && owed) {
      session.owesProviderChildWindDown = { ...owed, failedAt: session.journal.cursor() }
    }
    throw error
  } finally {
    // A person's close binds what its child's end cut; done, proven or not, it binds no more.
    void recorded.then((settle) => session.journal.stopMarks.settled(settle))
  }
}

/**
 * Retries the wind-down an earlier stop left owed, with that stop's own cause: a child it could
 * not prove gone takes no input, so nothing may write to it or start beside it until this lands.
 * One pass of the stop, bounded by its own step deadline (10 s): a shorter bound would cut a
 * supervised Claude's exit proof (up to about 7 s) short. Resolves whether nothing is owed now; a
 * failure is reported, never thrown, and leaves the exit unverifiable, never exited. Landing, the
 * stop itself hands over what waited on it.
 */
export async function finishOwedStructuredAgentSessionWindDownUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  const owed = session && pendingProviderChildWindDown(session)
  if (!owed) {
    return true
  }
  try {
    await stopStructuredAgentSessionAgentUnderSerialize(
      context,
      sessionId,
      owed.cause === 'user-stop'
        ? { recorded: 'user-stop', retry: true }
        : { cause: owed.cause, retry: true }
    )
  } catch (error) {
    context.deps.logger.warn('retrying an unfinished agent stop failed', {
      scope: 'owed-stop-retry',
      sessionId,
      error
    })
  }
  return context.sessions.get(sessionId)?.owesProviderChildWindDown === undefined
}

/** A close's cause: the user closing this chat, or the host evicting it (quit, idle, teardown). */
export type StructuredAgentSessionCloseCause = Extract<
  StructuredAgentSessionStopCause,
  'user-close' | 'evict'
>

/** Whether the conversation's handle is only a cache now: no child, no wind-down owed, and nothing
 *  queued or waiting on the provider. */
export function structuredAgentSessionConversationClosable(
  session: StructuredAgentSessionHostSession
): boolean {
  return (
    owedProviderChildWindDown(session) === undefined &&
    !session.journal.submissions().some(isQueuedAgentJournalSubmission) &&
    session.journal.pendingSubmissions().length === 0
  )
}

/**
 * Drops the conversation's open fold: a map delete, then its admitted writes drain. The entry
 * leaves the map first, so a lock-free reader sees an open conversation or none — never one that
 * is closing — and one arriving after the delete waits behind this step and reopens. Answers
 * false, closing nothing, when the conversation is still more than a cache.
 */
export async function closeStructuredAgentSessionConversationUnderSerialize(
  context: Pick<StructuredAgentSessionLifetimeContext, 'sessions'> & {
    /** The status row outlives the handle; see `StructuredAgentSessionClientDelivery`. */
    closeStatus: (sessionId: string) => void
  },
  sessionId: string
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  if (!session || !structuredAgentSessionConversationClosable(session)) {
    return false
  }
  context.sessions.delete(sessionId)
  context.closeStatus(sessionId)
  await session.journal.close()
  return true
}

/** Stops every provider child owned by this host while keeping failed evictions reachable. A
 *  session whose child is already stopped but whose wind-down aborted is still in scope — that is
 *  the retry. */
export async function evictOwnedStructuredAgentSessions(
  context: StructuredAgentSessionLifetimeContext & {
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  },
  retainOnFailure: Set<string>
): Promise<void> {
  const ownedSessionIds = [...context.sessions]
    .filter(([, session]) => owedProviderChildWindDown(session) !== undefined)
    .map(([sessionId]) => sessionId)
  // Retained up front and cleared only once a stop settles: the quit phase is bounded, and a
  // timeout leaves these still running. Closing their journals underneath them is the one outcome
  // the retain set exists to prevent.
  for (const sessionId of ownedSessionIds) {
    retainOnFailure.add(sessionId)
  }
  const failures: unknown[] = []
  await Promise.all(
    ownedSessionIds.map(async (sessionId) => {
      try {
        await context.serialize(sessionId, () =>
          stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, {
            cause: 'evict',
            quit: true
          })
        )
        retainOnFailure.delete(sessionId)
      } catch (error) {
        failures.push(error)
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'structured agent-session child eviction failed')
  }
}
