// What a Stop the provider took settles from its own answer, with no turn-ended event to wait on.

import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { runningTurnLifecycleRevisions } from './structured-agent-session-stale-turn-verdict'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { withdrawCodexSendsNoTurnOpenedFor } from './structured-agent-session-unopened-send-withdrawal'

/**
 * Settles the turn the provider says the Stop took: a turn with records that still reads running
 * ends interrupted, once, while the Stop still binds it; the provider's stream lands as it arrives,
 * so the fold already holds any end it sent. A turn with no record never opened, so the send it was
 * for is withdrawn as its child's end would withdraw it. Returns whether the turn had opened.
 * Bookkeeping: a failure is reported, never the Stop's.
 */
export async function settleTakenStop(
  ctx: AgentSessionTurnContext,
  turnId: string
): Promise<boolean> {
  let opened = false
  try {
    const records = ctx.journal
      .snapshot()
      .items.filter((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
    opened = records.length > 0
    if (!opened) {
      await withdrawCodexSendsNoTurnOpenedFor(ctx.journal, ctx.fence)
      return false
    }
    const mutations = runningTurnLifecycleRevisions(records, {
      state: 'interrupted',
      completedAt: ctx.now()
    })
    if (mutations.length > 0) {
      await ctx.journal.appendLifecycleBatch({
        settlementId: `stop-settled:${turnId}`,
        mutations,
        fence: ctx.fence
      })
    }
  } catch (error) {
    ctx.logger.warn('settling what a Stop took at its settle failed', {
      scope: 'stop-settle',
      sessionId: ctx.sessionId,
      error
    })
  }
  return opened
}
