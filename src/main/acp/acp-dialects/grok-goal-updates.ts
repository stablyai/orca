// Grok 1.0.77 reports its /goal state as `goal_updated` session notifications (recorded traffic).

import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { AgentJournalThreadGoalStatus } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AcpThreadGoalReport } from './acp-dialect'

const tokenCount = lazyZodSchema(() => z.number().int().nonnegative())
const goalUpdatedSchema = lazyZodSchema(() =>
  z.looseObject({
    sessionUpdate: z.literal('goal_updated'),
    goal_id: z.string(),
    objective: z.string(),
    status: z.string(),
    token_budget: tokenCount.nullish(),
    tokens_used: tokenCount.optional(),
    elapsed_ms: tokenCount.optional()
  })
)

// Grok splits pauses by cause; every one resumes with `/goal resume`.
const STATUS: Readonly<Record<string, AgentJournalThreadGoalStatus>> = {
  active: 'active',
  user_paused: 'paused',
  back_off_paused: 'paused',
  no_progress_paused: 'paused',
  infra_paused: 'paused',
  doom_loop_paused: 'paused',
  blocked: 'blocked',
  budget_limited: 'budgetLimited',
  complete: 'complete'
}

/** Undefined for other updates and for statuses this build cannot read. */
export function grokThreadGoalReport(update: unknown): AcpThreadGoalReport | undefined {
  const parsed = goalUpdatedSchema.safeParse(update)
  if (!parsed.success) {
    return undefined
  }
  const { data } = parsed
  if (data.status === 'cleared') {
    return { goal: null }
  }
  const status = STATUS[data.status]
  const objective = data.objective.trim()
  if (!status || !data.goal_id || !objective) {
    return undefined
  }
  return {
    goal: {
      id: data.goal_id,
      objective,
      status,
      tokenBudget: data.token_budget ?? null,
      tokensUsed: data.tokens_used ?? 0,
      timeUsedSeconds: Math.floor((data.elapsed_ms ?? 0) / 1000)
    }
  }
}
