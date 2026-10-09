import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'

export const MAX_RETAINED_SESSION_ACTIVITIES = 512

export function rememberSessionActivity(
  activities: Map<string, AgentSessionTurnActivity>,
  sessionId: string,
  activity: AgentSessionTurnActivity
): void {
  activities.delete(sessionId)
  activities.set(sessionId, activity)
  while (activities.size > MAX_RETAINED_SESSION_ACTIVITIES) {
    const oldest = activities.keys().next()
    if (oldest.done || oldest.value === sessionId) {
      break
    }
    activities.delete(oldest.value)
  }
}
