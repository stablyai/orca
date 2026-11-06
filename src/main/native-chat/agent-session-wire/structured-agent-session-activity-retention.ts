import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'

export const MAX_RETAINED_SESSION_ACTIVITIES = 512

/** Frame-only session state a later subscriber still needs; bounded so ended sessions cannot pile up. */
export class AgentSessionActivityRetention {
  private readonly activities = new Map<string, AgentSessionTurnActivity>()
  private readonly suggestions = new Map<string, string>()

  get activityCount(): number {
    return this.activities.size
  }

  /** Undefined leaves a value; null clears it. */
  record(
    sessionId: string,
    activity: AgentSessionTurnActivity | null | undefined,
    promptSuggestion: string | null | undefined
  ): void {
    retain(this.activities, sessionId, activity)
    retain(this.suggestions, sessionId, promptSuggestion)
  }

  activity(sessionId: string): AgentSessionTurnActivity | null {
    return this.activities.get(sessionId) ?? null
  }

  promptSuggestion(sessionId: string): string | null {
    return this.suggestions.get(sessionId) ?? null
  }

  /** A snapshot omits a missing suggestion, since it replaces the client's state anyway. */
  snapshotFields(sessionId: string): {
    activity: AgentSessionTurnActivity | null
    promptSuggestion?: string
  } {
    const promptSuggestion = this.suggestions.get(sessionId)
    return { activity: this.activity(sessionId), ...(promptSuggestion ? { promptSuggestion } : {}) }
  }
}

function retain<T>(values: Map<string, T>, sessionId: string, value: T | null | undefined): void {
  if (value === undefined) {
    return
  }
  values.delete(sessionId)
  if (!value) {
    return
  }
  values.set(sessionId, value)
  while (values.size > MAX_RETAINED_SESSION_ACTIVITIES) {
    const oldest = values.keys().next()
    if (oldest.done || oldest.value === sessionId) {
      break
    }
    values.delete(oldest.value)
  }
}
