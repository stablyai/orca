import type { EventName } from '../../shared/telemetry-events'

// Low-volume protected milestones: never sampled and exempt from the shared session ceiling.
const PROTECTED_MILESTONE_EVENTS: ReadonlySet<string> = new Set<EventName>([
  'first_agent_interaction',
  'meaningful_activity_day'
])

export function isProtectedMilestoneEvent(name: string): boolean {
  return PROTECTED_MILESTONE_EVENTS.has(name)
}

export function telemetryEventSampleRate(name: EventName): 0.01 | 0.001 | 1 {
  if (name === 'agent_prompt_sent' || name === 'native_chat_prompt_submitted') {
    return 0.01
  }
  if (name === 'daemon_audit_eligibility') {
    return 0.001
  }
  return 1
}
