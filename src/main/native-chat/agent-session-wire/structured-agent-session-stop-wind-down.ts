// A session-ending Stop's second step: the provider's wind-down, then the child's end, and what
// the Stop's note says when that end fails while the work runs on.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalStatusItem,
  type AgentJournalSubmission,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isMainAgentWorking, tookBackEverySend } from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'

/** What a Stop that ends the provider's session leaves its next serialized step: whether the
 *  provider took the interrupt, so its wind-down is worth waiting on, and when the interrupt went
 *  out. No turn id: that step runs right behind the Stop, so no later turn can slip in between. */
export type StructuredAgentSessionStopWindDown = {
  waitsForProvider: boolean
  stoppedAt: number
  /** The note the Stop wrote, which a failed wind-down revises. */
  stopNote: AgentJournalItemIdentity
  /** A note the Stop left to its end: written under `stopNote` unless the child's end took back
   *  every one of these sends, whose own rows then say they never started. */
  deferredNote?: {
    body: AgentJournalStatusItem
    turnScope: AgentJournalTurnScope
    unlessTakenBack: readonly AgentJournalSubmission[]
  }
  /** Closes the Stop's settle once the wind-down finishes, whether or not the child's exit was
   *  proven, marking the turn running on after an end that failed (`JournalStopSettle.failedOn`):
   *  until then, what ends is the Stop's. */
  settled?: (failedOn?: JournalStopFailedOn) => void
}

/**
 * A session-ending Stop's second step, queued behind its first in the same tick so nothing sent
 * meanwhile reaches the child it ends. The Stop has answered: a failure here is reported, and while
 * the work runs on its note is revised to say the Stop went unconfirmed. A close it could not prove
 * keeps the child on record, and the next operation that reaches the agent joins that close.
 */
export async function endStoppedStructuredAgentSession(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'adapter' | 'journal' | 'fence'>,
  windDown: StructuredAgentSessionStopWindDown,
  stopChild: () => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  let failedOn: JournalStopFailedOn | undefined
  try {
    if (windDown.waitsForProvider) {
      await ctx.adapter.awaitStoppedRequestEnd?.(ctx.sessionId, windDown.stoppedAt)
    }
    await stopChild()
    await writeDeferredStopNote(ctx, windDown, (taken) => !tookBackEverySend(ctx, taken)).catch(
      onError
    )
  } catch (error) {
    onError(error)
    failedOn = structuredAgentSessionFailedStopMark(ctx.journal)
    await writeDeferredStopNote(ctx, windDown, () => true).catch(onError)
    await reviseStopNoteUnconfirmed(ctx, windDown.stopNote).catch(onError)
  } finally {
    windDown.settled?.(failedOn)
  }
}

async function writeDeferredStopNote(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  windDown: StructuredAgentSessionStopWindDown,
  stillOwed: (taken: readonly AgentJournalSubmission[]) => boolean
): Promise<void> {
  const deferred = windDown.deferredNote
  if (deferred && stillOwed(deferred.unlessTakenBack)) {
    await ctx.journal.appendItem(windDown.stopNote, deferred.body, {
      fence: ctx.fence,
      turnScope: deferred.turnScope
    })
  }
}

/** While the work it stopped runs on, the Stop's own note, if it wrote one, says what a lost
 *  interrupt's says. Work that ended took the Stop, whatever became of the child. */
async function reviseStopNoteUnconfirmed(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  identity: AgentJournalItemIdentity
): Promise<void> {
  if (!isMainAgentWorking(ctx)) {
    return
  }
  const itemId = agentJournalItemKey(identity)
  let written: { turnScope?: AgentJournalTurnScope } | undefined
  ctx.journal.visitItemsWithLinkage((id, _sequence, _body, linkage) => {
    if (id === itemId) {
      written = linkage
    }
  })
  if (written === undefined) {
    return
  }
  const body: AgentJournalItemBody = {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
  }
  // The note now speaks of the work running on, so it moves onto that work's turn, keyed by it as a
  // Stop of that turn writes it: its proven end finds it there. A row keeps the scope it was created
  // with, so a note a Stop wrote before the turn showed is re-keyed, in one batch. Known limit: with
  // no turn open yet, the note keeps its key and scope, and no turn's end revises it.
  const running = ctx.journal.activeTurnId()
  const turnScope =
    running !== null ? structuredAgentSessionNamedTurnScope(ctx.journal, running) : null
  const onTurn = running !== null ? structuredAgentSessionStopNoteIdentity(running) : identity
  if (turnScope && agentJournalItemKey(onTurn) !== itemId) {
    await ctx.journal.appendLifecycleBatch({
      settlementId: `stop-note-on-turn:${itemId}`,
      fence: ctx.fence,
      mutations: [
        { kind: 'tombstone', identity },
        { kind: 'item', identity: onTurn, body, turnScope }
      ]
    })
    return
  }
  await ctx.journal.appendItem(identity, body, {
    fence: ctx.fence,
    turnScope: written.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
  })
}
