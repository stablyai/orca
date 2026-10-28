// Codex emits goal notifications without create_goal items; only notifications establish goal state.

import type {
  AgentJournalThreadGoal,
  AgentJournalThreadGoalState
} from '../../shared/agent-session-journal-types'
import { isAgentJournalThreadGoalStatus } from '../../shared/agent-session-thread-goal'

const GOAL_UPDATED_METHOD = 'thread/goal/updated'
const GOAL_CLEARED_METHOD = 'thread/goal/cleared'

const GOAL_STATUS_PREFIX: Record<string, string> = {
  active: 'Goal set',
  paused: 'Goal paused',
  blocked: 'Goal blocked',
  complete: 'Goal complete',
  usageLimited: 'Goal stopped — usage limit',
  budgetLimited: 'Goal stopped — token budget spent'
}

function goalRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const goal = (payload as Record<string, unknown>).goal
  return typeof goal === 'object' && goal !== null && !Array.isArray(goal)
    ? (goal as Record<string, unknown>)
    : null
}

export function isCodexGoalFrameMethod(method: string): boolean {
  return method === GOAL_UPDATED_METHOD || method === GOAL_CLEARED_METHOD
}

export function codexGoalRowText(method: string, payload: unknown): string | null {
  if (method === GOAL_CLEARED_METHOD) {
    return 'Goal cleared'
  }
  if (method !== GOAL_UPDATED_METHOD) {
    return null
  }
  const goal = goalRecord(payload)
  const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : ''
  const status = typeof goal?.status === 'string' ? goal.status : ''
  const prefix = GOAL_STATUS_PREFIX[status] ?? 'Goal updated'
  return objective ? `${prefix}: ${objective}` : prefix
}

/** Accounting changes stay in the raw disclosure without appending duplicate visible rows. */
export function codexGoalRowSignature(method: string, payload: unknown): string | null {
  if (method === GOAL_CLEARED_METHOD) {
    return GOAL_CLEARED_METHOD
  }
  if (method !== GOAL_UPDATED_METHOD) {
    return null
  }
  const goal = goalRecord(payload)
  const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : ''
  const status = typeof goal?.status === 'string' ? goal.status : ''
  return `${GOAL_UPDATED_METHOD}\u0000${status}\u0000${objective}`
}

/** Provider-owned goal generation, stable while accounting counters change. */
export function codexGoalGeneration(payload: unknown): string | null {
  const createdAt = goalRecord(payload)?.createdAt
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? String(createdAt) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function codexThreadGoal(record: Record<string, unknown> | null): AgentJournalThreadGoal | null {
  if (record === null) {
    return null
  }
  const tokensUsed = finiteNumber(record.tokensUsed)
  const timeUsedSeconds = finiteNumber(record.timeUsedSeconds)
  const createdAt = finiteNumber(record.createdAt)
  const updatedAt = finiteNumber(record.updatedAt)
  const tokenBudget = record.tokenBudget === null ? null : finiteNumber(record.tokenBudget)
  if (
    typeof record.objective !== 'string' ||
    typeof record.status !== 'string' ||
    !isAgentJournalThreadGoalStatus(record.status) ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    createdAt === null ||
    updatedAt === null ||
    (tokenBudget === null && record.tokenBudget !== null && record.tokenBudget !== undefined)
  ) {
    return null
  }
  return {
    objective: record.objective,
    status: record.status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    // Codex reports epoch seconds; the journal keeps epoch ms.
    createdAt: createdAt * 1000,
    updatedAt: updatedAt * 1000
  }
}

export function codexThreadGoalState(
  method: string,
  payload: unknown
): AgentJournalThreadGoalState | null {
  if (method === GOAL_CLEARED_METHOD) {
    return { state: 'cleared' }
  }
  if (method !== GOAL_UPDATED_METHOD) {
    return null
  }
  const goal = codexThreadGoal(goalRecord(payload))
  return goal ? { state: 'set', goal } : null
}
