import { z } from 'zod'
import type { AgentJournalThreadGoalState } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'

const STATUS_KEY = 'orca-pi-thread-goal-v1'
const report = z.discriminatedUnion('state', [
  z.object({ state: z.literal('cleared') }),
  z.object({
    state: z.literal('set'),
    goal: z
      .object({
        objective: z.string().trim().min(1).max(4000),
        status: z.enum(['active', 'paused', 'blocked', 'complete']),
        tokenBudget: z.null(),
        tokensUsed: z.number().int().nonnegative(),
        timeUsedSeconds: z.number().int().nonnegative(),
        createdAt: z.number().int().positive(),
        updatedAt: z.number().int().positive()
      })
      .refine((goal) => goal.updatedAt >= goal.createdAt)
  })
])

/** Only a namespaced Pi extension status can publish goal state. */
export function readPiRpcThreadGoal(frame: JsonlRpcRecord): AgentJournalThreadGoalState | null {
  if (
    frame.method !== 'setStatus' ||
    frame.statusKey !== STATUS_KEY ||
    typeof frame.statusText !== 'string' ||
    frame.statusText.length > 32_768
  ) {
    return null
  }
  try {
    const parsed = report.safeParse(JSON.parse(frame.statusText))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
