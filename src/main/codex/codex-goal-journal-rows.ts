/**
 * Codex thread goals reach us only as notifications: the `create_goal` tool call the
 * model makes is never emitted as an item, so `thread/goal/updated` is the single
 * truthful signal that a goal exists. The model narrates goals in prose either way,
 * and that prose can be wrong — it claims "Goal created" in sessions where no goal
 * was ever set — so the row below is what lets a reader tell the two apart.
 */

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
