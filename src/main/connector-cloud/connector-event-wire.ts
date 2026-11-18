// A conversation event as the cloud reads it; one a cloud can't read (by its hello's features) is left out.
import {
  cloudConversation,
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  type ConnectorCloudFeature,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import { SLACK_MIRROR_FEATURE } from '../../shared/connectors/connector-slack-mirror-contract'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { capUtf8, jsonBytes, unsupported } from './connector-snapshot'

/** Within the per-event cap. */
function promptEvent(event: Extract<ConnectorEvent, { kind: 'prompt' }>): ConnectorEvent {
  return jsonBytes(event) <= CONNECTOR_CLIENT_LIMITS.maxEventBytes
    ? event
    : { ...event, prompt: unsupported(event.prompt) }
}

/** `cloudFeatures`: what the cloud's hello answer listed; an event it can't read is left out. */
export function toConnectorEvent(
  event: ConversationEvent,
  cloudFeatures: ReadonlySet<string>
): ConnectorEvent | null {
  const conversation = cloudConversation(event.conversation)
  if (!conversation) {
    return null
  }
  const { paneKey } = event
  switch (event.kind) {
    case 'linked':
      return {
        kind: 'linked',
        conversation,
        paneKey,
        agent: event.agent,
        ...(event.actsFor ? { actsFor: event.actsFor } : {})
      }
    case 'unlinked':
      return cloudFeatures.has('threads.owner' satisfies ConnectorCloudFeature)
        ? { kind: 'unlinked', conversation, paneKey }
        : null
    case 'prompt':
      if (
        event.prompt.raisedBy === 'orca' &&
        !cloudFeatures.has(CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE)
      ) {
        return null
      }
      return promptEvent({
        kind: 'prompt',
        conversation,
        paneKey,
        prompt: event.prompt,
        ...(event.answered
          ? { answered: true, ...(event.answeredWith ? { answeredWith: event.answeredWith } : {}) }
          : {})
      })
    case 'turn-started':
      return {
        kind: 'turn-started',
        conversation,
        paneKey,
        at: event.at,
        ...(event.deliveryId ? { deliveryId: event.deliveryId } : {})
      }
    case 'turn-ended':
      // Without its start the cloud cannot place the turn; the next snapshot marks it unverifiable.
      return event.turnId === null
        ? null
        : {
            kind: 'turn-ended',
            conversation,
            paneKey,
            turnId: event.turnId,
            at: event.at,
            stopReason: event.stopReason,
            ...(event.lastAssistantMessage
              ? {
                  lastAssistantMessage: capUtf8(
                    event.lastAssistantMessage,
                    CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes
                  )
                }
              : {}),
            ...(event.origin ? { origin: event.origin } : {}),
            ...(event.failure ? { failure: event.failure } : {}),
            ...(event.links?.length ? { links: event.links } : {}),
            // A cloud without the mirror would read the reply as withheld anyway; it never gets the flag.
            ...(event.mirror && cloudFeatures.has(SLACK_MIRROR_FEATURE) ? { mirror: true } : {}),
            // Any deployed cloud honours it, whatever its hello lists (design item 125 §3).
            ...(event.stateOnly ? { stateOnly: true } : {}),
            ...(event.turnFor ? { turnFor: event.turnFor } : {})
          }
    case 'workers':
      return cloudFeatures.has('workers' satisfies ConnectorCloudFeature)
        ? { kind: 'workers', conversation, paneKey, running: event.running }
        : null
  }
}
