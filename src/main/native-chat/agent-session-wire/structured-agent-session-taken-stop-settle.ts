import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { runningTurnLifecycleRevisions } from './structured-agent-session-stale-turn-verdict'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { withdrawCodexSendsNoTurnOpenedFor } from './structured-agent-session-unopened-send-withdrawal'

/** Settle the accepted Stop’s still-bound turn once, or withdraw its send if no turn opened.
 * Streamed ends are already folded; settlement failures cannot change the accepted Stop. */
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
