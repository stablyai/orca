// The host's half of a session's lifetime: what a close does, and what a hold is wired to.
//
// Lifted out of the host for the same reason attaching was — the host is a coordinator, and the
// sequence that stops a provider child and hands its lease back reads better next to the holder
// bookkeeping that decides when to run it than buried among the twenty other things a session can
// do.

import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_REJECTED_PROVIDER_CLOSED } from '../../../shared/structured-agent-session-dispatch-rejection'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import { StructuredAgentSessionHolds } from './structured-agent-session-holds'
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
import { resumeHeldStructuredAgentSession } from './structured-agent-session-hold-resume'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
  /** Drops the session's row from the agent-status store; see `forgetStructuredAgentSession`. */
  forgetStatus: (sessionId: string) => void
  /** Re-projects the session's status after its agent stopped and the chat stays. */
  publishStatus?: (sessionId: string) => void
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

/** Dropping a session and dropping its status row are ONE operation: the store keeps the row until
 *  told, so a caller that only deletes strands a live-looking row no reader can ever decay. */
export async function forgetStructuredAgentSession(
  context: Pick<StructuredAgentSessionLifetimeContext, 'sessions' | 'forgetStatus'> & {
    deps: ConversationCloseDeps
  },
  sessionId: string
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (session) {
    await abandonQueuedStructuredAgentSessionMessages(context.deps, sessionId, session.journal)
  }
  await session?.journal.close()
  context.sessions.delete(sessionId)
  context.forgetStatus(sessionId)
}

function hasProviderChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): boolean {
  return (context.sessions.get(sessionId)?.child ?? null) !== null
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
 * stop is a real retry. A stop that cannot prove the exit still ends the child, and hands the lease
 * to recovery. `ending` is how the child's end is told: a user's Stop, the host stopping it for a
 * cause (with its text), a start the child was seen to die in, or an eviction whose close forgets
 * the conversation next.
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
      }
      if (verdict.rootGone) {
        context.restartWitness?.stopped(sessionId)
      }
    },
    acknowledgeRelease: () => context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      const fence =
        owed?.fence ?? structuredAgentSessionConversationFence(context.deps.store, sessionId)
      const settled = await settleStructuredAgentSessionDeadGeneration({
        journal: session.journal,
        sessionId,
        fence,
        settlementId: `expected-close:${sessionId}:${fence}:${owed?.generation ?? 'unknown'}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: context.now() },
        showUnexpectedExitOutcome: false,
        onError: (id, error) => {
          settlementError = error
          context.deps.onEventSinkError?.({ sessionId: id, error })
        }
      })
      if (!settled) {
        // Without the cause the quit log names the step and nothing else.
        throw new Error('dead generation work settlement failed', { cause: settlementError })
      }
    },
    releaseLease: async () => {
      if (owed) {
        await releaseStoredStructuredAgentSessionOwner({
          store: context.deps.store,
          sessionId,
          hasProviderChild: true,
          expectedFence: owed.fence,
          now: context.now(),
          // Read from the ended child, so a retry after a later step failed keeps the verdict.
          rootGone: endedChildRootGone(session, owed),
          ...(ending.reason ? { reason: ending.reason } : {})
        })
      }
      session.owesProviderChildWindDown = undefined
      if (ending.cause === 'evict') {
        context.forgetStatus(sessionId)
        return
      }
      // The conversation stays: its readers keep their own fence, and only the status moves.
      context.publishStatus?.(sessionId)
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
  return ended?.generation !== owed.generation || ended.fence !== owed.fence || ended.rootGone
}

/** Ends the conversation's resources, not the conversation: its child stops, and then its handle
 *  closes and it leaves the map. A stop that fails throws first, leaving it indexed for a retry. */
export async function evictHeldStructuredAgentSession(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  if (!context.sessions.has(sessionId)) {
    return
  }
  await stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, { cause: 'evict' })
  await forgetStructuredAgentSession(context, sessionId)
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
  // Retained up front and cleared only once an eviction settles: the quit phase is bounded, and a
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
          evictHeldStructuredAgentSession(context, sessionId)
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

/** The holds resume through the host's own attach, inside the session's serialize: a hold's
 *  resume and a send's ensure-owner step are the same serialized attach with a different asker. */
export function createStructuredAgentSessionHolds(
  attachContext: () => StructuredAgentSessionAttachContext,
  close: (sessionId: string) => Promise<void>,
  deliveryActive: (sessionId: string) => boolean
): StructuredAgentSessionHolds {
  const context = attachContext()
  return new StructuredAgentSessionHolds({
    resume: (sessionId, attachOptions) =>
      resumeHeldStructuredAgentSession({
        sessionId,
        context: attachContext(),
        callerKey: attachOptions?.admitRecoveryTicket
          ? 'trusted-local:provider-exit-recovery'
          : 'trusted-local:surface-hold',
        ...(attachOptions ? { attachOptions } : {})
      }),
    // Tracked from enqueue: a quit drains a queued resume before it evicts, so no child is
    // spawned behind the eviction and orphaned.
    serialize: (sessionId, task) => {
      const current = attachContext()
      return current.tasks.trackAttach(current.serialize(sessionId, task))
    },
    evict: close,
    hasProviderChild: (sessionId) => hasProviderChild(context, sessionId),
    // A message accepted and not yet handed over is owed to this child, and so is one pending while
    // the child still starts. Any other pending send may wait on an echo that never comes, so
    // eviction retires it. Subagents, commands and monitors outlive the lead's turn inside the
    // child, so the live roster the sidebar shows as working is owed too; stopping the child would
    // end them silently.
    hasOwedWork: (sessionId) => {
      const session = context.sessions.get(sessionId)
      return session
        ? activeStructuredAgentSessionTurnId(session.journal.snapshot().items) !== null ||
            deliveryActive(sessionId) ||
            session.journal.submissions().some(isQueuedAgentJournalSubmission) ||
            (session.child?.phase === 'starting' &&
              session.journal.pendingSubmissions().length > 0) ||
            agentChildWorkLiveness(context.deps.adapter.backgroundTaskState?.(sessionId)?.tasks) !==
              null
        : false
    },
    onError: (error) => context.deps.onEventSinkError?.(error),
    ...(context.deps.releaseGraceMs === undefined ? {} : { graceMs: context.deps.releaseGraceMs })
  })
}
