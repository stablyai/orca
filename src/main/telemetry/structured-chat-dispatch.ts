import { recordAgentStartTelemetry } from '../ipc/pty/pane/spawn-telemetry'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type {
  StructuredChatDispatchTelemetryEvent,
  StructuredChatStartTelemetryEvent,
  StructuredChatTelemetryEvent
} from '../../shared/structured-chat-dispatch-telemetry'
import { agentKindSchema } from '../../shared/telemetry-property-schemas'
import { isTelemetryInitialized, track } from './client'

type TelemetryListener = (event: StructuredChatTelemetryEvent, callerKey: string) => void
const remoteListeners = new Set<TelemetryListener>()
const receivedEvents = new Set<string>()
const dispatchEventSchema = z
  .object({
    type: z.literal('structuredChatMessageDispatch'),
    id: z.uuid(),
    agent_kind: agentKindSchema,
    outcome: z.enum(['transport_acknowledged', 'rejected'])
  })
  .strict()

const telemetryEventSchema = z.discriminatedUnion('type', [
  dispatchEventSchema,
  z.strictObject({
    type: z.literal('structuredChatAgentStart'),
    id: z.uuid(),
    agent_kind: agentKindSchema,
    launch_source: z.literal('unknown'),
    request_kind: z.enum(['new', 'resume'])
  })
])

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
    if (event.type === 'structuredChatAgentStart') {
      recordAgentStartTelemetry(event, 'structured')
    } else {
      track('native_chat_message_sent', {
        semantics_version: 2,
        client: 'desktop',
        backend: 'structured',
        action: 'message',
        outcome: event.outcome,
        agent_kind: event.agent_kind,
        runtime: 'remote'
      })
    }
  } catch {
    // A telemetry failure must not interrupt runtime event delivery.
  }
  return true
}

export function recordStructuredChatMessageDispatch(
  identity: AgentSessionJournalIdentity,
  state: 'accepted' | 'rejected',
  readCaller?: () => string | undefined
): void {
  try {
    const props = {
      semantics_version: 2,
      client: 'desktop',
      backend: 'structured',
      action: 'message',
      outcome: state === 'accepted' ? 'transport_acknowledged' : 'rejected',
      agent_kind: isTuiAgent(identity.agent) ? tuiAgentToAgentKind(identity.agent) : 'other',
      runtime:
        identity.hostId === 'local'
          ? 'local'
          : identity.hostId.startsWith('ssh:') || identity.hostId.startsWith('runtime:')
            ? 'remote'
            : 'unknown'
    } as const
    if (track('native_chat_message_sent', props) || isTelemetryInitialized()) {
      return
    }
    const callerKey = readCaller?.()
    if (!callerKey) {
      return
    }
    // Orcad has no desktop telemetry lifecycle; relay only committed, content-free outcomes.
    const event: StructuredChatDispatchTelemetryEvent = {
      type: 'structuredChatMessageDispatch',
      id: randomUUID(),
      agent_kind: props.agent_kind,
      outcome: props.outcome
    }
    relayStructuredChatTelemetry(event, callerKey)
  } catch {
    // A telemetry failure must not change the committed send outcome.
  }
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
