import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'

/**
 * Settles the turn the provider says the Stop took: a turn with records that still reads running
 * ends interrupted, once, while the Stop still binds it; the provider's stream lands as it arrives,
 * so the fold already holds any end it sent. With no record, delivery stays in doubt.
 * Returns whether the turn had opened.
 * Bookkeeping: a failure is reported, never the Stop's.
 */
export async function settleTakenStop(
  ctx: AgentSessionTurnContext,
  turnId: string
): Promise<boolean> {
  let opened = false
  try {
    opened = await ctx.journal.settleTakenStop(turnId, ctx.fence, ctx.now())
  } catch (error) {
    ctx.logger.warn('settling what a Stop took at its settle failed', {
      scope: 'stop-settle',
      sessionId: ctx.sessionId,
      error
    })
  }
  return opened
}
