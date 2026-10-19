import type { AgentSessionPublishedWork } from './agent-session-published-work'
import type { Subscriber } from './structured-agent-session-subscribers'
// Which per-emit fields ride one subscriber frame: the provider command catalog,
// the queue publication (the draft list with the queue's pause) and the strip's
// background-task roster. Each is deduplicated against the LAST VALUE SENT to that
// subscriber — never advanced on a frame that withheld the field, or the final
// replacement would be suppressed — and each attaches whole to hydrating frames.

import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import { boundedFrames } from './agent-session-bounded-frames'

export type SubscriberFieldState = {
  sessionId: string
  /** Every frame to fit a phone's bridge frame; see `boundedFrames`. */
  boundedFrames: boolean
  projectQueuePublication?: (publication: QueuePublication) => QueuePublication
  commands?: AgentSessionSlashCommand[] | null
  /** Canonical publication last sent, before reader projection. */
  queuePublication?: QueuePublication
  /** Fingerprint of the roster last SENT; absent until this subscriber's first frame. */
  backgroundTasks?: string
}

export type SubscriberFieldHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  /** Built from the host's child records, so it is read only when a frame owes it: never per token. */
  readBackgroundTasks?: (sessionId: string) => AgentSessionBackgroundTaskState | null
}

export type SubscriberFrame = {
  /** In order: one for most subscribers; for a bounded-frame one, its side lists follow. */
  frames: AgentSessionSubscribeEvent[]
  /** Undefined for a bounded-frame subscriber, which is never sent the list. */
  commands: AgentSessionSlashCommand[] | null | undefined
  attachedQueued: boolean
  queued: QueuePublication | undefined
  /** The attached roster's fingerprint; undefined when the frame carries none. */
  backgroundTasks: string | undefined
}

export function backgroundTaskFingerprint(state: AgentSessionBackgroundTaskState | null): string {
  return JSON.stringify(state)
}

/** Builds the frame to emit; the caller stores the returned refs only after the
 *  emit succeeded, so a dropped subscriber never advances its dedup state. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean
): SubscriberFrame {
  const commands = subscriber.boundedFrames
    ? undefined
    : (hooks.readCommands?.(subscriber.sessionId) ?? null)
  const includeCommands =
    hooks.readCommands !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || commands !== subscriber.commands)
  // Withheld on intermediate catch-up pages (the caller says so), attached to
  // every hydrating frame, and to batches only when the list changed.
  const queued = withholdQueued ? undefined : hooks.readQueuePublication?.(subscriber.sessionId)
  const attachedQueued =
    queued !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || queued !== subscriber.queuePublication)
  const backgroundTasks = subscriberBackgroundTasks(hooks, subscriber, event)
  const sideQueued = attachedQueued
    ? (subscriber.projectQueuePublication?.(queued) ?? queued)
    : undefined
  return {
    frames: subscriber.boundedFrames
      ? boundedFrames(event, { queued: sideQueued, backgroundTasks })
      : [
          {
            ...event,
            ...(includeCommands ? { commands: commands ?? null } : {}),
            ...(sideQueued
              ? {
                  queuedMessages: sideQueued.queuedMessages,
                  queuePause: sideQueued.queuePause,
                  nextQueuedMessageId: sideQueued.nextQueuedMessageId
                }
              : {}),
            ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
          }
        ],
    commands,
    attachedQueued,
    queued,
    backgroundTasks:
      backgroundTasks === undefined ? undefined : backgroundTaskFingerprint(backgroundTasks)
  }
}

/** A subscriber's first frame and every hydrating frame state the roster, so a client resuming
 *  from its cursor never keeps a roster that changed while it was away; a republish carries its
 *  own. Other batches leave it out: the client keeps what it holds. */
function subscriberBackgroundTasks(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent
): AgentSessionBackgroundTaskState | null | undefined {
  if (event.type === 'end') {
    return undefined
  }
  if (event.backgroundTasks !== undefined) {
    return event.backgroundTasks
  }
  return event.type !== 'batch' || subscriber.backgroundTasks === undefined
    ? hooks.readBackgroundTasks?.(subscriber.sessionId)
    : undefined
}

/** Whether the `/` list changed since this subscriber was last sent it. A bounded-frame subscriber
 *  is never sent it: a phone reads it from `agentSession.options`. */
export function subscriberCommandsChanged(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState
): boolean {
  return (
    !subscriber.boundedFrames &&
    hooks.readCommands !== undefined &&
    (hooks.readCommands(subscriber.sessionId) ?? null) !== subscriber.commands
  )
}

/** Whether a caught-up publish with no rows still owes this subscriber a frame:
 *  draft inserts and pause changes write no journal row, so an unchanged cursor
 *  must still deliver the changed publication. */
export function subscriberQueuedMessagesChanged(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState
): boolean {
  return (
    hooks.readQueuePublication !== undefined &&
    hooks.readQueuePublication(subscriber.sessionId) !== subscriber.queuePublication
  )
}

/** Publication contains only a version; read completion supplies payload delivery credit. */
export function emitSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent,
  options?: { withholdQueued?: boolean; currentWork?: AgentSessionPublishedWork }
): void {
  const marker =
    event.type !== 'end' && subscriber.readsCurrentRequests
      ? options?.currentWork?.requestProjection(subscriber.sessionId).marker
      : undefined
  const includeMarker =
    marker && (event.type !== 'batch' || marker.version !== subscriber.requestVersion)
  const built = buildSubscriberFrame(
    hooks,
    subscriber,
    includeMarker && event.type !== 'end' ? { ...event, currentRequests: marker } : event,
    options?.withholdQueued === true
  )
  for (const outgoing of built.frames) {
    subscriber.emit(outgoing)
  }
  if (includeMarker) {
    subscriber.requestVersion = marker.version
  }
  subscriber.commands = built.commands
  if (built.attachedQueued) {
    subscriber.queuePublication = built.queued
  }
  if (built.backgroundTasks !== undefined) {
    subscriber.backgroundTasks = built.backgroundTasks
  }
}
