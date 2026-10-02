// The host's conversations: how one becomes open, and the delivery loop that hands its accepted
// messages to a provider child. Bundled because they share one invariant — a conversation open
// with a message queued has a delivery loop — and the open is where a loop for leftovers wakes.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { abandonQueuedStructuredAgentSessionMessages } from './structured-agent-session-host-lifetime'
import type { AgentJournalResetReason } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  openStructuredAgentSessionConversation,
  resettleOpenStructuredAgentSessionConversation,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenOptions
} from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { recoverStructuredRewind } from './structured-rewind-recovery'

export type StructuredAgentSessionConversationDelivery = {
  loop: StructuredAgentSessionDeliveryLoop
  /** For a caller inside the session's serialize. */
  open: (
    sessionId: string,
    options?: StructuredAgentSessionConversationOpenOptions
  ) => Promise<StructuredAgentSessionHostSession | null>
  /** Every commit a conversation's journal makes: one may have ended the command that held its
   *  queue. Enqueued through the session's serialize, never read here, so a commit that lands while
   *  a step is deciding to stop wakes the loop after that step rather than being lost to it. */
  afterCommit: (sessionId: string, journal: AgentSessionJournal) => void
  /** Stops the loop and the resettle on a proof of death; quit's first step. */
  dispose: () => void
  /** Indexes a conversation some other open produced, as `open` would have. */
  adoptOpened: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void>
}

export function createStructuredAgentSessionConversationDelivery(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Starts a child for `startedFor`, the queued message at the head, if the session has none. */
  ensureProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
  reset: (sessionId: string, journal: AgentSessionJournal, reset: AgentJournalResetReason) => void
  clientDelivery: Pick<StructuredAgentSessionClientDelivery, 'publishRestored' | 'readChildWork'>
  flushStreamedEvents: (sessionId: string) => Promise<void>
}): StructuredAgentSessionConversationDelivery {
  const { deps, sessions } = input
  const loop = new StructuredAgentSessionDeliveryLoop({
    sessions,
    adapter: deps.adapter,
    serialize: input.serialize,
    trackStart: input.trackStart,
    ensureProviderChild: input.ensureProviderChild,
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(deps.store, sessionId),
    abandonQueued: async (sessionId, which) => {
      const session = sessions.get(sessionId)
      return session
        ? abandonQueuedStructuredAgentSessionMessages(deps, sessionId, session.journal, which)
        : true
    },
    failureTextContext: (sessionId) =>
      structuredAgentSessionFailureWordsContext(
        deps.store.getRecord(sessionId),
        sessions.get(sessionId)?.journal
      ),
    logger: deps.logger,
    record: (sessionId) => deps.store.getRecord(sessionId),
    readChildWork: input.clientDelivery.readChildWork,
    flushStreamedEvents: input.flushStreamedEvents,
    now: () => deps.now?.() ?? Date.now()
  })
  const adoptOpened = async (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ): Promise<void> => {
    const { session, reset } = opened
    sessions.set(sessionId, session)
    if (reset) {
      input.reset(sessionId, session.journal, reset)
    }
    input.clientDelivery.publishRestored(sessionId)
    await settleInterruptedCommands(deps, sessionId, session)
    if (session.journal.submissions().some(isQueuedAgentJournalSubmission)) {
      loop.wake(sessionId)
    }
  }
  const wakesQueued = new Set<string>()
  const afterCommit = (sessionId: string, journal: AgentSessionJournal): void => {
    if (
      wakesQueued.has(sessionId) ||
      structuredAgentSessionCommandRunning(journal) ||
      !journal.submissions().some(isQueuedAgentJournalSubmission)
    ) {
      return
    }
    wakesQueued.add(sessionId)
    void input
      .serialize(sessionId, async () => {
        wakesQueued.delete(sessionId)
        loop.wake(sessionId)
      })
      .catch((error: unknown) => {
        wakesQueued.delete(sessionId)
        deps.logger.warn('waking the delivery loop after a commit failed', {
          scope: 'delivery-wake',
          sessionId,
          error
        })
      })
  }
  // A chat open before its owner's death was proven revises what its open settled. Queued, never
  // awaited: the writer can hold this session's serialize (an attach recovering its lease).
  const stopResettling = deps.store.onDeathEvidence((sessionId) => {
    if (sessions.has(sessionId)) {
      void input
        .trackStart(
          input.serialize(sessionId, () =>
            resettleOpenStructuredAgentSessionConversation(deps, sessionId, sessions.get(sessionId))
          )
        )
        .catch((error: unknown) =>
          deps.logger.warn('resettling an open chat after its owner died failed', {
            scope: 'death-evidence-resettle',
            sessionId,
            error
          })
        )
    }
  })
  return {
    loop,
    afterCommit,
    adoptOpened,
    dispose: () => {
      loop.dispose()
      stopResettling()
    },
    open: (sessionId, options) =>
      openStructuredAgentSessionConversation({ deps, sessions, adoptOpened }, sessionId, options)
  }
}

/**
 * A rewind found prepared when the conversation opens was started under a child this process no
 * longer has — the open runs only when none is indexed — so nothing will finish it, and left alone
 * it refuses every send until a view attaches. Settled here instead of by a start inside
 * acceptance. A Codex rewind only its provider can prove stays for the attach.
 */
async function settleInterruptedCommands(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession
): Promise<void> {
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  try {
    await recoverStructuredRewind(deps, sessionId, session.journal, fence)
  } catch (error) {
    deps.logger.warn('settling an interrupted rewind on open failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
  }
}
