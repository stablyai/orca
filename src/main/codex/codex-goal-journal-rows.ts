/**
 * Codex thread goals reach us only as notifications: the `create_goal` tool call the
 * model makes is never emitted as an item, so `thread/goal/updated` is the single
 * truthful signal that a goal exists. The model narrates goals in prose either way,
 * and that prose can be wrong — it claims "Goal created" in sessions where no goal
 * was ever set — so the row below is what lets a reader tell the two apart.
 */

import type {
  AgentJournalThreadGoal,
  AgentJournalThreadGoalState
} from '../../shared/agent-session-journal-types'
import { isAgentJournalThreadGoalStatus } from '../../shared/agent-session-thread-goal'

const GOAL_UPDATED_METHOD = 'thread/goal/updated'
const GOAL_CLEARED_METHOD = 'thread/goal/cleared'

/** Status values Codex can report, mapped to how a reader would say them. */
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

/** The sentence for a goal frame, or null when the frame is not one. */
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
  // An unknown future status still says something true rather than falling back to
  // the bare opcode.
  const prefix = GOAL_STATUS_PREFIX[status] ?? 'Goal updated'
  return objective ? `${prefix}: ${objective}` : prefix
}

/**
 * What changes the visible sentence. Counters and budget stay in the raw disclosure but
 * cannot append another row with identical copy.
 */
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

/** Codex's goal object in journal form; null when any field is missing or unknown. */
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

/** The typed transition a goal frame records, or null for any other frame. */
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
