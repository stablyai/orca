// A conversation event as the cloud reads it; one a cloud can't read (by its hello's features) is left out.
import {
  cloudConversation,
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  type ConnectorCloudFeature,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import {
  cloudSupportsConnectorSource,
  CONNECTOR_CLOUD_LONG_ANSWERS_FEATURE,
  CONNECTOR_CLOUD_TURN_ACTIVITY_FEATURE,
  CONNECTOR_REPLIES_PAUSED_FEATURE
} from '../../shared/connector-cloud-features'
import { CONNECTOR_LONG_ANSWER_BYTES } from '../../shared/connectors/connector-turn-activity-contract'
import { SLACK_MIRROR_FEATURE } from '../../shared/connectors/connector-slack-mirror-contract'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { capAnswer, jsonBytes, unsupported } from './connector-snapshot'
import { redactLocalPaths } from '../../shared/connectors/slack-local-paths'
import { isSlackConversation } from './connector-slack-text'

/** Within the per-event cap. */
function promptEvent(event: Extract<ConnectorEvent, { kind: 'prompt' }>): ConnectorEvent {
  return jsonBytes(event) <= CONNECTOR_CLIENT_LIMITS.maxEventBytes
    ? event
    : { ...event, prompt: unsupported(event.prompt) }
}

/** Unsupported live events are omitted; durable turn ends wait in the outbox for a capable Cloud. */
export function toConnectorEvent(
  event: ConversationEvent,
  cloudFeatures: ReadonlySet<string>
): ConnectorEvent | null {
  const conversation = cloudConversation(event.conversation)
  if (
    !conversation ||
    (event.kind !== 'turn-ended' &&
      !cloudSupportsConnectorSource(conversation.source, cloudFeatures))
  ) {
    return null
  }
  const { paneKey } = event
  const slack = isSlackConversation(conversation)
  const shown = (text: string): string => (slack ? redactLocalPaths(text) : text)
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
                  // Kept whole to the long cap: what goes is cut to the cloud it goes to.
                  lastAssistantMessage: capAnswer(
                    shown(event.lastAssistantMessage),
                    CONNECTOR_LONG_ANSWER_BYTES
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
            // Retained across hellos; the receiving cloud's capability is checked at send time.
            ...(event.resumes ? { resumes: true } : {}),
            ...(event.turnFor ? { turnFor: event.turnFor } : {})
          }
    case 'workers':
      return cloudFeatures.has('workers' satisfies ConnectorCloudFeature)
        ? { kind: 'workers', conversation, paneKey, running: event.running }
        : null
    case 'activity':
      return cloudFeatures.has(CONNECTOR_CLOUD_TURN_ACTIVITY_FEATURE)
        ? {
            kind: 'activity',
            conversation,
            paneKey,
            turnId: event.turnId,
            ...(event.text === undefined ? {} : { text: shown(event.text) }),
            ...(event.steps?.length
              ? { steps: event.steps.map((step) => ({ ...step, title: shown(step.title) })) }
              : {})
          }
        : null
  }
}

/** An answer's words as this cloud takes them: within the older cap, said to be cut, for one that
 *  doesn't list `answers.long`. */
export function answerTextFor(text: string, cloudFeatures: ReadonlySet<string>): string {
  return cloudFeatures.has(CONNECTOR_CLOUD_LONG_ANSWERS_FEATURE)
    ? text
    : capAnswer(text, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
}

/**
 * An event as this cloud takes it. Read as each batch goes, since an answer waits across
 * hellos and the cloud it finally reaches may not be the one it was written for.
 */
export function answerFor(
  written: ConnectorEvent,
  cloudFeatures: ReadonlySet<string>
): ConnectorEvent {
  let event = written
  if (
    event.kind === 'turn-ended' &&
    event.resumes &&
    !cloudFeatures.has(CONNECTOR_REPLIES_PAUSED_FEATURE)
  ) {
    const { resumes: _resumes, ...supported } = event
    event = supported
  }
  // One already within the cap goes as the same object: what binds to a sent event still finds it.
  if (event.kind === 'turn-ended' && event.lastAssistantMessage !== undefined) {
    // Again here: a turn end saved to disk before it was scrubbed is sent from there.
    const said = isSlackConversation(event.conversation)
      ? redactLocalPaths(event.lastAssistantMessage)
      : event.lastAssistantMessage
    const lastAssistantMessage = answerTextFor(said, cloudFeatures)
    return lastAssistantMessage === event.lastAssistantMessage
      ? event
      : { ...event, lastAssistantMessage }
  }
  if (event.kind === 'reply' && event.prose !== undefined) {
    const said = isSlackConversation(event.conversation)
      ? redactLocalPaths(event.prose)
      : event.prose
    const prose = answerTextFor(said, cloudFeatures)
    return prose === event.prose ? event : { ...event, prose }
  }
  return event
}
