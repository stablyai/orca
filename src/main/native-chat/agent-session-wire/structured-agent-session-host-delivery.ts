// The host's conversations: how one becomes open, and the delivery loop that hands its accepted
// messages to a provider child. Bundled because they share one invariant — a conversation open
// with a message queued has a delivery loop — and the open is where a loop for leftovers wakes.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalResetReason } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  openStructuredAgentSessionConversation,
  type OpenedStructuredAgentSessionConversation
} from './structured-agent-session-conversation-open'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionStartFailureText } from './structured-agent-session-send-preparation'
import { recoverStructuredRewind } from './structured-rewind-recovery'

export type StructuredAgentSessionConversationDelivery = {
  loop: StructuredAgentSessionDeliveryLoop
  /** For a caller inside the session's serialize. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
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
  ensureProviderChild: (sessionId: string) => Promise<StructuredAgentSessionResumeOutcome>
  reset: (sessionId: string, journal: AgentSessionJournal, reset: AgentJournalResetReason) => void
  publishRestored: (sessionId: string) => void
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
    startFailureText: (sessionId, cause) =>
      structuredAgentSessionStartFailureText(deps.store.getRecord(sessionId), cause),
    onError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error }),
    record: (sessionId) => deps.store.getRecord(sessionId),
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
    input.publishRestored(sessionId)
    await settleInterruptedCommands(deps, sessionId, session)
    if (session.journal.submissions().some(isQueuedAgentJournalSubmission)) {
      loop.wake(sessionId)
    }
  }
  return {
    loop,
    adoptOpened,
    open: (sessionId) =>
      openStructuredAgentSessionConversation({ deps, sessions, adoptOpened }, sessionId)
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
    await recoverStructuredRewind(deps.store, sessionId, session.journal, fence)
  } catch (error) {
    deps.onEventSinkError?.({ sessionId, error })
  }
}
