import type { EventName } from '../../shared/telemetry/telemetry-event-classification'
import type { Store } from '../persistence/loading-store/store'

// Low-volume protected milestones: never sampled and exempt from the shared session ceiling.
const PROTECTED_MILESTONE_EVENTS: ReadonlySet<string> = new Set<EventName>([
  'first_agent_interaction',
  'meaningful_activity_day'
])

export function isProtectedMilestoneEvent(name: string): boolean {
  return PROTECTED_MILESTONE_EVENTS.has(name)
}

// First chat send per client each UTC day stays exact for adoption and active-day counts.
export type ChatClient = 'desktop' | 'mobile'
const chatMessageSentDay = new Map<ChatClient, number>()

function chatClient(props: unknown): ChatClient {
  return props !== null &&
    typeof props === 'object' &&
    'client' in props &&
    props.client === 'mobile'
    ? 'mobile'
    : 'desktop'
}

const utcDayNumber = (now: number): number => Math.floor(now / 86_400_000)

/** `savedChatDay` seeds the day cursor once per client per launch so restarts stay sampled. */
export function telemetryEventSampleRate(
  name: EventName,
  props: unknown,
  now: number,
  savedChatDay: (client: ChatClient) => number | undefined
): 0.1 | 0.01 | 0.001 | 1 {
  if (name === 'native_chat_message_sent') {
    const client = chatClient(props)
    let day = chatMessageSentDay.get(client)
    if (day === undefined) {
      day = savedChatDay(client) ?? -1
      chatMessageSentDay.set(client, day)
    }
    return day === utcDayNumber(now) ? 0.1 : 1
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
export function noteTelemetryEventQueued(
  name: EventName,
  props: unknown,
  now: number,
  store: Store
): void {
  if (name !== 'native_chat_message_sent') {
    return
  }
  const client = chatClient(props)
  const day = utcDayNumber(now)
  if (chatMessageSentDay.get(client) === day) {
    return
  }
  chatMessageSentDay.set(client, day)
  const telemetry = store.getSettings().telemetry
  if (!telemetry) {
    return
  }
  try {
    store.updateSettings({
      telemetry: {
        ...telemetry,
        chatMessageSentDays: { ...telemetry.chatMessageSentDays, [client]: day }
      }
    })
  } catch (err) {
    console.warn('[telemetry] failed to persist chat sampling day', err)
  }
}

export function resetEventSamplingForSession(): void {
  chatMessageSentDay.clear()
}
