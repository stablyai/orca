// Stop releases the provider child/lease while keeping conversation state; close drops its cached fold.
// Call under existing serialization because session queues are nonreentrant.

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
import { markStructuredQueueReopen } from './structured-agent-session-queued-pause'
import type { StructuredAgentSessionStopCause } from './structured-agent-session-adapter'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import {
  recordStructuredAgentSessionShutdownCut,
  runningRootTurnItemId
} from './structured-agent-session-orca-stop-row'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
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
  publishStatus?: (sessionId: string) => void
  generationEnded?: (sessionId: string) => void
  wakeDelivery?: (sessionId: string) => void
  endExitedChild: (
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    exit: StructuredAgentSessionChildExit
  ) => Promise<void>
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'logger'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}

/** Keep personal unsent text as cards and mark reopen before close; quit leaves recovery to next open.
 * Partial-close rechecks mark only settled sends; failures report and return false. */
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
    // Start the mark at settled sends so a later wake-up send is not held.
    await markStructuredQueueReopen(sessionId, journal, fence, deps.logger, settled.newest + 1)
  }
  return settled.ok
}

/** Retry failed open recovery without handing over earlier-process sends; failures propagate. */
export async function holdRestartedStructuredAgentSessionSends(
  logger: StructuredAgentSessionHostDeps['logger'],
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  fence: number
): Promise<void> {
  const settled = await holdUnsentSends(journal, { fence, hold: { cause: 'hostRestarted' } })
  if (settled !== null) {
    await markStructuredQueueReopen(sessionId, journal, fence, logger, settled + 1)
  }
}

/** Join close until root exit proves release; unproven exits throw but retain retryable close state.
 * The first Stop’s ending determines presentation. */
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
    // Issue ordered Stop bookkeeping before kill without waiting for its persistence.
    const recorded = (await stopEndsWork(context, sessionId, session, ending))
      ? recordStopEvent(context, sessionId, session, ending)
      : Promise.resolve(null)
    child.close = {
      cause,
      ...('quit' in ending && ending.quit ? { quit: true as const } : {}),
      reason: ('reason' in ending ? ending.reason : undefined) ?? null,
      ...('failure' in ending && ending.failure ? { failure: ending.failure } : {}),
      recorded,
      requestedAt: session.journal.cursor()
    }
  } else if (child.close.cause === cause) {
    // Repeated same-cause closes include newer queued work and rebind what shutdown cuts.
    child.close.requestedAt = session.journal.cursor()
    child.close.recorded = child.close.recorded.then((settle) =>
      settle ? session.journal.stopMarks.beginSettle() : null
    )
  }
  const { close } = child
  const quitCuts = 'quit' in ending && ending.quit ? runningRootTurnItemId(session.journal) : null
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
    if (
      (await joinStructuredAgentSessionChildClose(
        context,
        sessionId,
        child,
        'recorded' in ending ? ending.observeClose : undefined
      )) !== 'exited'
    ) {
      throw new StructuredAgentSessionEvictionError(
        'stop-provider-child',
        sessionId,
        new Error('provider child exit was not proven')
      )
    }
    if ('quit' in ending && ending.quit) {
      const record = context.deps.store.getRecord(sessionId)
      await recordStructuredAgentSessionShutdownCut({
        journal: session.journal,
        sessionId,
        fence: child.fence,
        rowFence: Math.max(child.fence, record?.lease.runtimeFence ?? child.fence),
        generation: child.generation ?? 'unknown',
        turnItemId: quitCuts,
        trigger: ending.quit,
        ...(record
          ? { failureTextContext: structuredAgentSessionFailureWordsContext(record) }
          : {}),
        logger: context.deps.logger
      })
    }
  } finally {
    // Close binds only the turn it cut; settled shutdown must bind no future work.
    void close?.recorded.then((settle) => session.journal.stopMarks.settled(settle))
  }
}

export type StructuredAgentSessionCloseCause = Extract<
  StructuredAgentSessionStopCause,
  'user-close' | 'evict'
>

/** Idle cache eviction also retains waiting cards so unseen closes cannot introduce reopen pauses. */
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

/** Delete before draining so lock-free readers see open-or-absent, never closing; reject noncache handles. */
export async function closeStructuredAgentSessionConversationUnderSerialize(
  context: Pick<StructuredAgentSessionLifetimeContext, 'sessions'> & {
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

export async function evictOwnedStructuredAgentSessions(
  context: StructuredAgentSessionLifetimeContext & {
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  },
  retainOnFailure: Set<string>,
  trigger: AgentSessionResumeTrigger = 'quit'
): Promise<void> {
  const ownedSessionIds = [...context.sessions]
    .filter(([, session]) => session.child !== null)
    .map(([sessionId]) => sessionId)
  // Retain owned sessions before bounded eviction so timeout cannot close journals under live children.
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
            quit: trigger
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
