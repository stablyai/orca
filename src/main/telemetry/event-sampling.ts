import type { EventName } from '../../shared/telemetry/telemetry-event-classification'

// Low-volume protected milestones: never sampled and exempt from the shared session ceiling.
const PROTECTED_MILESTONE_EVENTS: ReadonlySet<string> = new Set<EventName>([
  'first_agent_interaction',
  'meaningful_activity_day'
])

export function isProtectedMilestoneEvent(name: string): boolean {
  return PROTECTED_MILESTONE_EVENTS.has(name)
}

// First chat send per client each UTC day stays exact for adoption and active-day counts.
const chatMessageSentDay = new Map<'desktop' | 'mobile', number>()

function chatClient(props: unknown): 'desktop' | 'mobile' {
  return props !== null &&
    typeof props === 'object' &&
    'client' in props &&
    props.client === 'mobile'
    ? 'mobile'
    : 'desktop'
}

const utcDayNumber = (now: number): number => Math.floor(now / 86_400_000)

export function telemetryEventSampleRate(
  name: EventName,
  props: unknown,
  now: number
): 0.1 | 0.01 | 0.001 | 1 {
  if (name === 'native_chat_message_sent') {
    return chatMessageSentDay.get(chatClient(props)) === utcDayNumber(now) ? 0.1 : 1
  }
  if (name === 'agent_prompt_sent' || name === 'native_chat_prompt_submitted') {
    return 0.01
  }
  if (name === 'daemon_audit_eligibility') {
    return 0.001
  }
  return 1
}

/** Call only once the event is queued, so a dropped first send leaves the next one exact. */
export function noteTelemetryEventQueued(name: EventName, props: unknown, now: number): void {
  if (name === 'native_chat_message_sent') {
    chatMessageSentDay.set(chatClient(props), utcDayNumber(now))
  }
}

export function resetEventSamplingForSession(): void {
  chatMessageSentDay.clear()
}
