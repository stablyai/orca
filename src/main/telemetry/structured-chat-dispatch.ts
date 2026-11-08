import { recordAgentStartTelemetry } from '../ipc/pty/pane/spawn-telemetry'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  StructuredChatStartTelemetryEvent,
  StructuredChatTelemetryEvent
} from '../../shared/structured-chat-dispatch-telemetry'
import { agentKindSchema } from '../../shared/telemetry-property-schemas'
import { isTelemetryInitialized } from './client'

type TelemetryListener = (event: StructuredChatTelemetryEvent, callerKey: string) => void
const remoteListeners = new Set<TelemetryListener>()
const receivedEvents = new Set<string>()
const telemetryEventSchema = z.strictObject({
  type: z.literal('structuredChatAgentStart'),
  id: z.uuid(),
  agent_kind: agentKindSchema,
  launch_source: z.literal('unknown'),
  request_kind: z.enum(['new', 'resume'])
})

/** Live, best-effort delivery; outcomes settled without the caller connected are not replayed. */
export function subscribeStructuredChatTelemetry(listener: TelemetryListener): () => void {
  remoteListeners.add(listener)
  return () => remoteListeners.delete(listener)
}

/** Consume host events in desktop main, where installation identity and consent live. */
export function recordRemoteStructuredChatTelemetry(value: unknown): boolean {
  const parsed = telemetryEventSchema.safeParse(value)
  if (!parsed.success) {
    return false
  }
  const event = parsed.data
  if (receivedEvents.has(event.id)) {
    return true
  }
  receivedEvents.add(event.id)
  if (receivedEvents.size > 1024) {
    receivedEvents.delete(receivedEvents.values().next().value!)
  }
  try {
    recordAgentStartTelemetry(event, 'structured')
  } catch {
    // A telemetry failure must not interrupt runtime event delivery.
  }
  return true
}

export function recordStructuredChatAgentStart(
  telemetry: Pick<
    StructuredChatStartTelemetryEvent,
    'agent_kind' | 'launch_source' | 'request_kind'
  >,
  readCaller: () => string | undefined
): void {
  try {
    if (recordAgentStartTelemetry(telemetry, 'structured') || isTelemetryInitialized()) {
      return
    }
    const callerKey = readCaller()
    if (!callerKey) {
      return
    }
    relayStructuredChatTelemetry(
      { type: 'structuredChatAgentStart', id: randomUUID(), ...telemetry },
      callerKey
    )
  } catch {
    // Telemetry must not change a proved start outcome.
  }
}

function relayStructuredChatTelemetry(
  event: StructuredChatTelemetryEvent,
  callerKey: string
): void {
  for (const listener of remoteListeners) {
    try {
      listener(event, callerKey)
    } catch {
      // A disconnected client must not prevent delivery to other desktops.
    }
  }
}
