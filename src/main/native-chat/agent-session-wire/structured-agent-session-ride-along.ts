// What rides ahead of a person's words, once: the host's turn context, then unread automation results.
// Ahead of all that, what this message alone needs said, on every send of a person's message.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  isPromptCommand
} from '../../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionHandoverContext } from './host/structured-agent-session-host-types'
import { agentSessionInstructionsContext } from '../../runtime/agent-session/records/agent-session-instructions-receipt'
import type { AutomationResultNote } from '../../../shared/bots/bot-automation-result-note'
import {
  automationResultsRideAlong,
  carriedAutomationResults,
  markAutomationResultsRead,
  sendCarriesRideAlong,
  withRideAlong
} from './structured-agent-session-automation-results'

export type StructuredAgentSessionRideAlong = {
  /** Claims what rides, after the pending write. A fresh agent started for this send reads the host's
   *  context again, so it never gets what its start already gave it. */
  claim: (fence: number, turnScope: AgentJournalTurnScope) => Promise<void>
  outgoing: (sent: AgentJournalMessageItem) => AgentJournalMessageItem
  /** The agent took the turn: the host's context is given, and its row is written. */
  taken: (fence: number) => Promise<void>
}

// Synchronous to the pending write: a yield before it lets the loop hand over a settled send again.
export function structuredAgentSessionRideAlong(
  ctx: Pick<AgentSessionHandoverContext, 'sessionId' | 'journal' | 'turnContext'> &
    Partial<Pick<AgentSessionHandoverContext, 'record' | 'recordRanOptions'>>,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): StructuredAgentSessionRideAlong {
  // Every message that starts a turn names it, attachments or not; the plan rides only on some.
  const readPlan = (scope: AgentJournalTurnScope) => {
    if (scope.kind === 'thread') {
      ctx.turnContext?.handedOver?.(ctx.sessionId, body)
    }
    if (!ctx.turnContext || scope.kind !== 'thread') {
      return Promise.resolve(null)
    }
    carried = sendCarriesRideAlong(scope, submission, body)
    if (carried) {
      return ctx.turnContext.plan(ctx.sessionId, body, held)
    }
    // A command must open the prompt; the update waits for the next turn it can go ahead of.
    return isPromptCommand(body)
      ? Promise.resolve(null)
      : (ctx.turnContext.launchUpdate?.(ctx.sessionId, held) ?? Promise.resolve(null))
  }
  // Whether the whole ride-along goes with this send; otherwise only a launch update, kept apart from
  // the message's own blocks.
  let carried = false
  let plan: Awaited<ReturnType<typeof readPlan>> = null
  let results: AutomationResultNote[] = []
  let mentions: string | null = null
  /** The provider context the plan was read against; its receipt lands only in that one. */
  let context: string | null = null
  let held: string | null | undefined
  return {
    claim: async (fence, scope) => {
      const record = ctx.record?.()
      context = record ? agentSessionInstructionsContext(record) : null
      held = record ? (record.instructionsKey ?? null) : undefined
      const [read, named] = await Promise.all([
        readPlan(scope),
        agentSessionSendDeliversStoppedHistory(submission, body)
          ? ctx.turnContext?.mentions?.(ctx.sessionId, body).catch(() => null)
          : null
      ])
      plan = read
      mentions = named ?? null
      results = await carriedAutomationResults(ctx.journal, scope, submission, body)
      await markAutomationResultsRead(ctx.journal, results, submission.clientMessageId, fence)
    },
    outgoing: (sent) => {
      // A plan may only vouch for what the launch gave, with nothing to say.
      const text = plan?.text || null
      const own =
        carried || !text
          ? withRideAlong(sent, [...(text ? [text] : []), ...automationResultsRideAlong(results)])
          : { ...sent, blocks: [{ type: 'text' as const, text }, ...sent.blocks] }
      if (!mentions) {
        return own
      }
      return agentSessionSendCarriesStoppedHistory(own)
        ? withRideAlong(own, [mentions])
        : { ...own, blocks: [{ type: 'text' as const, text: mentions }, ...own.blocks] }
    },
    taken: async (fence) => {
      const writeReceipt = ctx.recordRanOptions?.instructions
      if (!plan) {
        return
      }
      const key = plan.instructionsKey
      // At least once: a crash before this write sends them again, which is harmless.
      const instructionsRecorded =
        key !== undefined && context !== null && writeReceipt
          ? await writeReceipt(key, context)
          : false
      plan.given({ instructionsRecorded })
      if (!plan.note) {
        return
      }
      await ctx.journal.appendItem(
        {
          provider: 'orca',
          clientMessageId: `turn-context:${submission.clientMessageId}`
        },
        plan.note,
        { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
  }
}
