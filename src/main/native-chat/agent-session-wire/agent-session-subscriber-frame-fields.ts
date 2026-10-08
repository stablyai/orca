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

export type SubscriberFieldState = {
  sessionId: string
  commands?: AgentSessionSlashCommand[] | null
  /** The last queue publication actually SENT. */
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
  frame: AgentSessionSubscribeEvent
  commands: AgentSessionSlashCommand[] | null
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
  const commands = hooks.readCommands?.(subscriber.sessionId) ?? null
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
  return {
    frame: {
      ...event,
      ...(includeCommands ? { commands: commands ?? null } : {}),
      ...(attachedQueued && queued
        ? {
            queuedMessages: queued.queuedMessages,
            queuePause: queued.queuePause,
            nextQueuedMessageId: queued.nextQueuedMessageId
          }
        : {}),
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    },
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
