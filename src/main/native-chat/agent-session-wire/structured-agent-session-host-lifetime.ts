// The host's half of a session's lifetime: what a close does, and what a hold is wired to.
//
// Lifted out of the host for the same reason attaching was — the host is a coordinator, and the
// sequence that stops a provider child and hands its lease back reads better next to the holder
// bookkeeping that decides when to run it than buried among the twenty other things a session can
// do.

import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
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
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

/** Dropping a session and dropping its status row are ONE operation: the store keeps the row until
 *  told, so a caller that only deletes strands a live-looking row no reader can ever decay. */
export async function forgetStructuredAgentSession(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  await context.sessions.get(sessionId)?.journal.close()
  context.sessions.delete(sessionId)
  context.forgetStatus(sessionId)
}

function hasProviderChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): boolean {
  return context.sessions.get(sessionId)?.hasProviderChild === true
}

/** The wind-down this host owes for the session's child. A live child always owes one, whatever a
 *  previous childless eviction recorded — the same session object is re-acquired in place on a
 *  handoff back to native, so a remembered `false` must never outrank the child in front of it. */
function owesProviderChildWindDown(session: StructuredAgentSessionHostSession): boolean {
  return session.hasProviderChild || session.owesProviderChildWindDown === true
}

/** Runs the eviction steps under a deadline. A step that fails — or runs out of time — aborts the
 *  rest, which leaves the session indexed and the child loaded so the next close is a real retry. */
export async function evictHeldStructuredAgentSession(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  // The obligation OUTLIVES the child. `hasProviderChild` is retired the instant the adapter
  // proves the exit, so a step that aborts after that point would otherwise leave the retry
  // reading "no child here" and skipping the settlement and the lease release it still owes.
  const owesWindDown = owesProviderChildWindDown(session)
  session.owesProviderChildWindDown = owesWindDown
  let settlementError: unknown
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    // The retry must not re-stop a child the adapter already proved gone, so this stays honest.
    hasProviderChild: session.hasProviderChild,
    owesProviderChildWindDown: owesWindDown,
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    ...(context.restartWitness
      ? { beforeProviderChildStop: () => context.restartWitness?.beforeStop(sessionId) }
      : {}),
    // Host state must not disagree with the adapter for the seven steps in between.
    onProviderChildStopped: () => {
      session.hasProviderChild = false
      context.restartWitness?.stopped(sessionId)
    },
    forget: async () => {
      await forgetStructuredAgentSession(context, sessionId)
      context.deps.adapter.acknowledgeSessionRelease?.(sessionId)
    },
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      const settled = await settleStructuredAgentSessionDeadGeneration({
        journal: session.journal,
        sessionId,
        fence: session.fence,
        settlementId: `expected-close:${sessionId}:${session.fence}:${session.acquisitionGeneration ?? 'unknown'}`,
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
      await releaseStoredStructuredAgentSessionOwner({
        store: context.deps.store,
        sessionId,
        hasProviderChild: owesWindDown,
        expectedFence: session.fence,
        now: context.now()
      })
      session.owesProviderChildWindDown = false
      context.forgetStatus(sessionId)
    }
  }
  await evictStructuredAgentSession(
    eviction,
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
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
    .filter(([, session]) => owesProviderChildWindDown(session))
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
  close: (sessionId: string) => Promise<void>
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
    // A send pending while the child is still starting is held for that start; evicting would
    // refuse it. Any other pending send may wait on an echo that never comes, so eviction retires it.
    hasOwedWork: (sessionId) => {
      const session = context.sessions.get(sessionId)
      return session
        ? activeStructuredAgentSessionTurnId(session.journal.snapshot().items) !== null ||
            (session.providerChildPhase === 'starting' &&
              session.journal.pendingSubmissions().length > 0)
        : false
    },
    onError: (error) => context.deps.onEventSinkError?.(error),
    ...(context.deps.releaseGraceMs === undefined ? {} : { graceMs: context.deps.releaseGraceMs })
  })
}
