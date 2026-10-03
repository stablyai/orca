// A session-ending Stop's second step: the provider's wind-down, then the child's end, and what
// the Stop's note says when that end fails while the work runs on.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'

/** What a Stop that ends the provider's session leaves its next serialized step: whether the
 *  provider took the interrupt, so its wind-down is worth waiting on, and when the interrupt went
 *  out. No turn id: that step runs right behind the Stop, so no later turn can slip in between. */
export type StructuredAgentSessionStopWindDown = {
  waitsForProvider: boolean
  stoppedAt: number
  /** The note the Stop wrote, which a failed wind-down revises. */
  stopNote: AgentJournalItemIdentity
  /** Closes the Stop's settle once the wind-down finishes, whether or not the child's exit was
   *  proven, marking the turn running on after an end that failed (`JournalStopSettle.failedOn`):
   *  until then, what ends is the Stop's. */
  settled?: (failedOn?: JournalStopFailedOn) => void
}

/**
 * A session-ending Stop's second step, queued behind its first in the same tick so nothing sent
 * meanwhile reaches the child it ends. The Stop has answered: a failure here is reported, and while
 * the work runs on its note is revised to say the Stop went unconfirmed. The next operation that
 * reaches the agent retries the wind-down it leaves owed, and so does the idle sweep's next tick.
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
  } catch (error) {
    onError(error)
    failedOn = structuredAgentSessionFailedStopMark(ctx.journal)
    await reviseStopNoteUnconfirmed(ctx, windDown.stopNote).catch(onError)
  } finally {
    windDown.settled?.(failedOn)
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
  await ctx.journal.appendItem(
    identity,
    {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
    },
    { fence: ctx.fence, turnScope: written.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE }
  )
}
