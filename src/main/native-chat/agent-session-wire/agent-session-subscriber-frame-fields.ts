import type { AgentSessionPublishedWork } from './agent-session-published-work'
import type { Subscriber } from './structured-agent-session-subscribers'
// Deduplicate against last sent values only; withheld fields must not suppress final replacements.

// Deduplicate against last sent values only; withheld fields must not suppress final replacements.
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import { boundedFrames } from './agent-session-bounded-frames'

export type SubscriberFieldState = {
  commandsOnRequest?: boolean
  sessionId: string
  boundedFrames: boolean
  projectQueuePublication?: (publication: QueuePublication) => QueuePublication
  commands?: AgentSessionSlashCommand[] | null
  /** Deduplicate canonical state before reader-specific projection. */
  queuePublication?: QueuePublication
  backgroundTasks?: string
}

export type SubscriberFieldHooks = {
  readCommands?: (
    sessionId: string,
    commandsOnRequest?: boolean
  ) => AgentSessionSlashCommand[] | undefined
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  /** Read expensive child-derived rosters only when a frame owes them. */
  readBackgroundTasks?: (sessionId: string) => AgentSessionBackgroundTaskState | null
}

export type SubscriberFrame = {
  /** Bounded subscribers receive side lists after history. */
  frames: AgentSessionSubscribeEvent[]
  /** Last observed inventory also deduplicates bounded command-change hints. */
  commands: AgentSessionSlashCommand[] | null | undefined
  attachedQueued: boolean
  queued: QueuePublication | undefined
  backgroundTasks: string | undefined
}

export function backgroundTaskFingerprint(state: AgentSessionBackgroundTaskState | null): string {
  return JSON.stringify(state)
}

/** Advance dedup references only after successful emission. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean
): SubscriberFrame {
  const commands =
    subscriber.boundedFrames && !subscriber.commandsOnRequest
      ? undefined
      : (hooks.readCommands?.(subscriber.sessionId, subscriber.commandsOnRequest) ?? null)
  const includeCommands =
    !subscriber.boundedFrames &&
    hooks.readCommands !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || commands !== subscriber.commands)
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
      ? boundedFrames(event, { queued: sideQueued, backgroundTasks }).map((frame, index) =>
          index === 0 &&
          frame.type !== 'end' &&
          subscriber.commandsOnRequest &&
          (event.type !== 'batch' || event.commandsChanged || commands !== subscriber.commands)
            ? { ...frame, commandsChanged: true }
            : frame
        )
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

/** First/hydrating frames restate rosters changed while disconnected; ordinary batches keep prior state. */
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

/** Capable phones receive a small invalidation hint instead of the inventory. */
export function subscriberCommandsChanged(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState
): boolean {
  return (
    (!subscriber.boundedFrames || subscriber.commandsOnRequest === true) &&
    hooks.readCommands !== undefined &&
    (hooks.readCommands(subscriber.sessionId, subscriber.commandsOnRequest) ?? null) !==
      subscriber.commands
  )
}

/** Changed queue publications still require delivery when the subscriber is already caught up. */
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
