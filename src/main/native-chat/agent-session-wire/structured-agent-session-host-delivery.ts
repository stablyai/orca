// The host's conversations: how one becomes open, and the delivery loop that hands its accepted
// messages to a provider child. Bundled because they share one invariant — a conversation open
// with a message queued has a delivery loop — and the open is where a loop for leftovers wakes.

import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { holdClosedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  openStructuredAgentSessionConversation,
  type OpenedStructuredAgentSessionConversation
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
import { retireSignedOutStructuredAgentSessionChild } from './structured-agent-session-signed-out-child'

export type StructuredAgentSessionConversationDelivery = {
  loop: StructuredAgentSessionDeliveryLoop
  /** For a caller inside the session's serialize. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Every commit a conversation's journal makes: one may have ended the command that held its
   *  queue. Enqueued through the session's serialize, never read here, so a commit that lands while
   *  a step is deciding to stop wakes the loop after that step rather than being lost to it. */
  afterCommit: (sessionId: string, journal: AgentSessionJournal) => void
  /** A person's Stop settle opened or closed. It writes no row, so only what reads the settle
   *  moves: the session's status row and the steer hold's handover. Never activity. */
  afterSettleEdge: (sessionId: string, journal: AgentSessionJournal) => void
  /** Stops the loop; quit's first step. */
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
  /** Stops a child that reported it is not signed in, so the start after it reads a new login. */
  stopSignedOutAgent: (sessionId: string) => Promise<void>
  clientDelivery: Pick<
    StructuredAgentSessionClientDelivery,
    'publishRestored' | 'readChildWork' | 'readStopping' | 'publishStatus'
  >
}): StructuredAgentSessionConversationDelivery {
  const { deps, sessions } = input
  const loop = new StructuredAgentSessionDeliveryLoop({
    sessions,
    adapter: deps.adapter,
    agents: deps.agents,
    serialize: input.serialize,
    trackStart: input.trackStart,
    ensureProviderChild: async (sessionId, startedFor) => {
      // A send waiting on a person's Stop is not handed over yet; the step after the Stop decides.
      const session = input.clientDelivery.readStopping(sessionId)
        ? undefined
        : sessions.get(sessionId)
      await retireSignedOutStructuredAgentSessionChild(sessionId, session, {
        work: {
          currentWork: () =>
            hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId),
          childWork: () => input.clientDelivery.readChildWork(sessionId),
          hasOpenDispatch: () => {
            const record = deps.store.getRecord(sessionId)
            return record !== null && deps.hasOpenDispatch?.(record) === true
          },
          providerHoldsDispatch: () => deps.adapter.holdsDispatch?.(sessionId) === true
        },
        startUnavailable: () => deps.adapter.startUnavailable?.(sessionId),
        stopAgent: input.stopSignedOutAgent,
        logger: deps.logger
      })
      return input.ensureProviderChild(sessionId, startedFor)
    },
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(deps.store, sessionId),
    holdClosed: async (sessionId, which) => {
      const session = sessions.get(sessionId)
      return session
        ? holdClosedStructuredAgentSessionSends(deps, sessionId, session.journal, {
            mark: 'settled',
            which
          })
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
    stopping: input.clientDelivery.readStopping,
    now: () => deps.now?.() ?? Date.now()
  })
  const adoptOpened = async (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ): Promise<void> => {
    // Indexing a chat writes nothing: the loop never hands over a send an earlier process left
    // (`StructuredAgentSessionCurrentWork.handsOver`), and keeping one as a card is startup's.
    sessions.set(sessionId, opened.session)
    input.clientDelivery.publishRestored(sessionId)
  }
  const wakesQueued = new Set<string>()
  const afterCommit = (sessionId: string, journal: AgentSessionJournal): void => {
    const work = hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId)
    if (
      wakesQueued.has(sessionId) ||
      !work ||
      structuredAgentSessionCommandRunning(work) ||
      !journal.submissions().some((submission) => work.handsOver(submission))
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
  return {
    loop,
    afterCommit,
    afterSettleEdge: (sessionId, journal) => {
      input.clientDelivery.publishStatus(sessionId)
      afterCommit(sessionId, journal)
    },
    adoptOpened,
    dispose: () => loop.dispose(),
    open: (sessionId) =>
      openStructuredAgentSessionConversation({ deps, sessions, adoptOpened }, sessionId)
  }
}
