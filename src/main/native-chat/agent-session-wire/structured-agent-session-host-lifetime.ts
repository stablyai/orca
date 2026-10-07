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
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import {
  snapshotBeforeStructuredAgentSessionStop,
  StructuredAgentSessionEvictionError
} from './structured-agent-session-eviction'
import { joinStructuredAgentSessionChildClose } from './structured-agent-session-child-close'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionChildExit } from './structured-agent-session-child-exit'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import {
  markStructuredQueueReopen,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
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
  /** The one exit handler (`structured-agent-session-child-exit`), for a caller inside the
   *  session's serialize that proved its child's exit. */
  endExitedChild: (
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    exit: StructuredAgentSessionChildExit
  ) => Promise<void>
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'logger'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}

/** What is still queued when the chat closes will not be handed over: a person's message is kept
 *  as a card that waits for the chat's next turn, the rest rejected (`journal-unsent-send-hold.ts`).
 *  A quit is not a close: the next open settles what it left. The chat stops running, so the
 *  reopen mark follows (`markStructuredQueueReopen`): on every `close`, or only once it settled a
 *  send, for a later re-check of the same close, which must never mark past a new send. `which` narrows it to the messages a close that did not complete
 *  closed. Best effort, so a close never waits on it: resolves false when it failed, reported and
 *  never thrown. */
export async function holdClosedStructuredAgentSessionSends(
  deps: ConversationCloseDeps,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  close: { mark: 'always' | 'settled'; which?: (submission: AgentJournalSubmission) => boolean }
): Promise<boolean> {
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  const { which } = close
  const settled = await holdUnsentSends(journal, {
    fence,
    hostInstance: structuredAgentSessionHostInstance(),
    hold: { cause: 'chatClosed', ...(which ? { which } : {}) }
  }).then(
    (newest) => ({ ok: true, newest }),
    (error: unknown) => {
      deps.logger.warn('settling queued messages of a closed chat failed', {
        scope: 'queued-abandon',
        sessionId,
        error
      })
      return { ok: false, newest: null }
    }
  )
  if (close.mark === 'always') {
    await markStructuredQueueReopen(sessionId, journal, fence, deps.logger)
  } else if (settled.newest !== null) {
    // A send that woke this re-check came after the ones it settled: the mark starts at them.
    await markStructuredQueueReopen(sessionId, journal, fence, deps.logger, settled.newest + 1)
  }
  return settled.ok
}

/** What an earlier host process left queued and the open could not settle (its write failed):
 *  kept or rejected now, never handed over. A failure throws. A send that woke this came after the
 *  ones it settled, so the reopen mark starts where they did. */
export async function holdRestartedStructuredAgentSessionSends(
  logger: StructuredAgentSessionHostDeps['logger'],
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  fence: number
): Promise<void> {
  const hostInstance = structuredAgentSessionHostInstance()
  const settled = await holdUnsentSends(journal, {
    fence,
    hostInstance,
    hold: { cause: 'hostRestarted' }
  })
  if (settled !== null) {
    await markStructuredQueueReopen(sessionId, journal, fence, logger, settled + 1)
  }
}

/**
 * The agent goes to rest; the conversation stays. Begins the child's close, or joins the one
 * already begun, and waits for the exit's proof as long as a caller may. Still unproven, it throws
 * and the close keeps running: a later proof, or the next asker's attempt, ends the record.
 * `ending` is how the child's end is told: a user's Stop, the host stopping it for a cause (with
 * its text), or an eviction the conversation's close follows. The first stop's ending decides.
 */
export async function stopStructuredAgentSessionAgentUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  ending: StructuredAgentSessionStopEnding
): Promise<void> {
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (!session || !child) {
    return
  }
  const cause = 'recorded' in ending ? ending.recorded : ending.cause
  if (!child.close) {
    // Judged before the kill: a stop that ends nothing writes nothing. Its event is issued before
    // the kill and never awaited by it; the journal writes rows in order.
    const recorded = (await stopEndsWork(context, sessionId, session, ending))
      ? recordStopEvent(context, sessionId, session, ending)
      : Promise.resolve(null)
    child.close = {
      cause,
      ...('quit' in ending && ending.quit ? { quit: true as const } : {}),
      reason: ('reason' in ending ? ending.reason : undefined) ?? null,
      recorded,
      requestedAt: session.journal.cursor()
    }
  } else if (child.close.cause === cause) {
    // The same stop asked again, such as a second close of the chat, closes what came since, and
    // binds again what its child's end cuts.
    child.close.requestedAt = session.journal.cursor()
    child.close.recorded = child.close.recorded.then((settle) =>
      settle ? session.journal.stopMarks.beginSettle() : null
    )
  }
  const { close } = child
  try {
    if (context.restartWitness) {
      await snapshotBeforeStructuredAgentSessionStop(
        {
          sessionId,
          eventSink: context.runtimeState.eventSinkFor(sessionId),
          logger: context.deps.logger
        },
        () => context.restartWitness?.beforeStop(sessionId)
      )
    }
    if ((await joinStructuredAgentSessionChildClose(context, sessionId, child)) !== 'exited') {
      throw new StructuredAgentSessionEvictionError(
        'stop-provider-child',
        sessionId,
        new Error('provider child exit was not proven')
      )
    }
  } finally {
    // A person's close binds what its child's end cut; done, proven or not, it binds no more.
    void close?.recorded.then((settle) => session.journal.stopMarks.settled(settle))
  }
}

/** A close's cause: the user closing this chat, or the host evicting it (quit, idle, teardown). */
export type StructuredAgentSessionCloseCause = Extract<
  StructuredAgentSessionStopCause,
  'user-close' | 'evict'
>

/** Whether the conversation's handle is only a cache now: no child, and nothing queued or waiting
 *  on the provider. `atRest`: the idle sweep's own close, which also keeps a chat with a card
 *  waiting, since a reopen marks it to wait for a turn (`markStructuredQueueReopen`), and an
 *  eviction the person never saw must not; a person's close has marked them already. */
export function structuredAgentSessionConversationClosable(
  session: StructuredAgentSessionHostSession,
  atRest = false
): boolean {
  return (
    session.child === null &&
    !session.journal.submissions().some(isQueuedAgentJournalSubmission) &&
    session.journal.pendingSubmissions().length === 0 &&
    !(atRest && session.journal.queuedMessages.awaitReopenMark())
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
  sessionId: string,
  atRest = false
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  if (!session || !structuredAgentSessionConversationClosable(session, atRest)) {
    return false
  }
  context.sessions.delete(sessionId)
  context.closeStatus(sessionId)
  await session.journal.close()
  return true
}

/** Stops every provider child owned by this host while keeping failed evictions reachable. */
export async function evictOwnedStructuredAgentSessions(
  context: StructuredAgentSessionLifetimeContext & {
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  },
  retainOnFailure: Set<string>
): Promise<void> {
  const ownedSessionIds = [...context.sessions]
    .filter(([, session]) => session.child !== null)
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
