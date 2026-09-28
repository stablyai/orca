// The host's half of a session's lifetime: stopping its agent, and closing its conversation.
//
// Two operations, because they end two different things. Stopping the agent ends the provider
// child and hands the lease back; the conversation — its open journal, its status row and its
// readers — stays, and the next send starts a new child. Closing the conversation drops the open
// journal handle, a cache the next read or write reopens.
//
// Both are written for a caller already inside the session's serialize: the queue is not
// reentrant, so every public entry point takes it once and calls these.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_REJECTED_PROVIDER_CLOSED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  endProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { settleEndedStructuredAgentSessionChildWork } from './structured-agent-session-dead-generation-settlement'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
  /** Re-projects the session's status after its agent stopped and the chat stays. */
  publishStatus?: (sessionId: string) => void
  /** Tells the conversation's readers the fence a release moved it to. */
  publishFence?: (sessionId: string, session: StructuredAgentSessionHostSession) => void
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'onEventSinkError'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}

/** A conversation's handle closes with nothing queued: what is still queued when the chat closes,
 *  or the app quits, will not be handed over. Best effort: the next open's delivery loop rejects a
 *  leftover itself. */
export async function abandonQueuedStructuredAgentSessionMessages(
  deps: ConversationCloseDeps,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal']
): Promise<void> {
  await journal
    .rejectQueuedSubmissions(
      structuredAgentSessionConversationFence(deps.store, sessionId),
      DISPATCH_REJECTED_PROVIDER_CLOSED
    )
    .catch((error: unknown) => deps.onEventSinkError?.({ sessionId, error }))
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

/**
 * The agent goes to rest; the conversation stays. Runs the eviction steps under a deadline. A step
 * that fails — or runs out of time — aborts the rest and leaves the wind-down owed, so the next
 * stop is a real retry; a failed drain, settlement or recovery is only reported. A stop that cannot
 * prove the exit still ends the child, and runs recovery on its lease. `ending` is how the child's
 * end is told: a user's Stop, the host stopping it for a cause (with its text), a start the child
 * was seen to die in, or an eviction the conversation's close follows.
 */
export async function stopStructuredAgentSessionAgentUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  ending: {
    cause: Extract<
      StructuredAgentSessionChildEndCause,
      'user-stop' | 'host-stop' | 'exit' | 'evict'
    >
    reason?: string
  } = { cause: 'user-stop' }
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  // The obligation OUTLIVES the child. `child` is ended the instant the adapter proves the exit,
  // so a step that aborts after that point would otherwise leave the retry reading "no child
  // here" and skipping the settlement and the lease release it still owes.
  const owed = owedProviderChildWindDown(session)
  session.owesProviderChildWindDown = owed
  const stopping = session.child
  let settlementError: unknown
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    // The retry must not re-stop a child the adapter already proved gone, so this stays honest.
    hasProviderChild: stopping !== null,
    owesProviderChildWindDown: owed !== undefined,
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    ...(context.restartWitness
      ? { beforeProviderChildStop: () => context.restartWitness?.beforeStop(sessionId) }
      : {}),
    // Host state must not disagree with the adapter for the steps in between.
    onProviderChildStopped: (verdict) => {
      if (stopping) {
        endProviderChild(session, {
          generation: stopping.generation,
          fence: stopping.fence,
          cause: ending.cause,
          reason: ending.reason ?? null,
          duringStartup: stopping.phase === 'starting',
          ...verdict
        })
        // Now, not at the release: a later step that aborts must not leave the row on a live child.
        context.publishStatus?.(sessionId)
      }
      if (verdict.rootGone) {
        context.restartWitness?.stopped(sessionId)
      }
    },
    acknowledgeRelease: () => context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    onBestEffortStepFailure: (error) => context.deps.onEventSinkError?.({ sessionId, error }),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      const settled = await settleEndedStructuredAgentSessionChildWork({
        journal: session.journal,
        sessionId,
        child: owed ?? {
          generation: null,
          fence: structuredAgentSessionConversationFence(context.deps.store, sessionId)
        },
        now: context.now(),
        // Reported once, by the step's failure below.
        onError: (_id, error) => {
          settlementError = error
        }
      })
      if (!settled) {
        // Without the cause the report names the step and nothing else.
        throw new Error('dead generation work settlement failed', { cause: settlementError })
      }
    },
    releaseLease: async () => {
      const released =
        owed !== undefined &&
        (await releaseStoredStructuredAgentSessionOwner({
          store: context.deps.store,
          sessionId,
          hasProviderChild: true,
          expectedFence: owed.fence,
          now: context.now(),
          // Read from the ended child, so a retry after a later step failed keeps the verdict.
          rootGone: endedChildRootGone(session, owed),
          ...(ending.reason ? { reason: ending.reason } : {})
        }))
      session.owesProviderChildWindDown = undefined
      // A death seen here is the exit the provider's own event would have released and published;
      // whichever gets there first releases, so its readers hear the new fence exactly once. Any
      // other stop leaves them their own fence.
      if (released && ending.cause === 'exit') {
        context.publishFence?.(sessionId, session)
      }
      // Whatever ended the child, the row belongs to the conversation: it shows not-running, and
      // only the conversation's close forgets it.
      context.publishStatus?.(sessionId)
    },
    resolveRecovery: async () => {
      // Concluding moves the fence as a proven release would, so it tells the same readers.
      const resolved = await context.runtimeState.resolveRecovery(sessionId)
      if (resolved === 'resolved' && ending.cause === 'exit') {
        context.publishFence?.(sessionId, session)
      }
    }
  }
  await evictStructuredAgentSession(
    eviction,
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
}

function endedChildRootGone(
  session: StructuredAgentSessionHostSession,
  owed: StructuredAgentSessionProviderChildIdentity
): boolean {
  const ended = session.lastEndedChild
  return (
    ended !== undefined &&
    ended.generation === owed.generation &&
    ended.fence === owed.fence &&
    ended.rootGone
  )
}

/** Marks in doubt, as the open would, a send an ended child was handed and never answered. With no
 *  child left to answer it, it is all that keeps the handle from closing, and the reopen settles
 *  the rest. For a caller inside serialize with no child; false when it could not be written. */
export async function markLeftoverStructuredAgentSessionSendsUnknown(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  if (!session || session.journal.pendingSubmissions().length === 0) {
    return true
  }
  try {
    await session.journal.markPendingSubmissionsUnknown(
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      DISPATCH_DOUBT_PROVIDER_EXITED
    )
    return true
  } catch (error) {
    context.deps.onEventSinkError?.({ sessionId, error })
    return false
  }
}

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
 * Drops the conversation's open handle. The entry leaves the map BEFORE the handle closes, so a
 * lock-free reader sees an open handle or none — never one that is closing — and one arriving
 * after the delete waits behind this step and reopens. Answers false, closing nothing, when the
 * handle is still more than a cache.
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
          stopStructuredAgentSessionAgentUnderSerialize(context, sessionId)
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
