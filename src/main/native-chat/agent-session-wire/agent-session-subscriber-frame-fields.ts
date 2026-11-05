import { mapAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionPublishedWork } from './agent-session-published-work'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { Subscriber } from './structured-agent-session-subscribers'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session/agent-session-background-task-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import { boundedFrameSteps } from './agent-session-bounded-frames'
// Deduplicate against last sent values only; withheld fields must not suppress final replacements.

export type SubscriberFieldState = {
  commandsOnRequest?: boolean
  sessionId: string
  cursor?: AgentJournalCursor
  /** Every frame to fit a phone's bridge frame; see `boundedFrames`. */
  boundedFrames: boolean
  projectQueuePublication?: (publication: QueuePublication) => QueuePublication
  projectQueuePublicationSteps?: (
    publication: QueuePublication
  ) => Generator<void, QueuePublication>
  projectJournalEventSteps?: (
    ...args: Parameters<NonNullable<SubscriberFieldState['projectJournalEvent']>>
  ) => Generator<void, AgentSessionSubscribeEvent>
  projectJournalEvent?: (
    journal: AgentSessionJournal,
    event: AgentSessionSubscribeEvent,
    previous: QueuePublication | undefined,
    current: QueuePublication | undefined,
    work?: AgentSessionPublishedWork
  ) => AgentSessionSubscribeEvent
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
  readQueuePublicationSteps?: (sessionId: string) => Generator<void, QueuePublication | undefined>
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

/** Advance dedup references only after successful emission. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean,
  work?: AgentSessionPublishedWork,
  journal?: AgentSessionJournal
): SubscriberFrame {
  return finishJournalSteps(
    buildSubscriberFrameSteps(hooks, subscriber, event, withholdQueued, work, journal)
  )
}

export function* buildSubscriberFrameSteps(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean,
  work?: AgentSessionPublishedWork,
  journal?: AgentSessionJournal
): Generator<void, SubscriberFrame> {
  const commands =
    subscriber.boundedFrames && !subscriber.commandsOnRequest
      ? undefined
      : (hooks.readCommands?.(subscriber.sessionId, subscriber.commandsOnRequest) ?? null)
  const includeCommands =
    !subscriber.boundedFrames &&
    hooks.readCommands !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || commands !== subscriber.commands)
  const queued =
    withholdQueued || (subscriber.projectJournalEvent && !journal)
      ? undefined
      : hooks.readQueuePublicationSteps
        ? yield* hooks.readQueuePublicationSteps(subscriber.sessionId)
        : hooks.readQueuePublication?.(subscriber.sessionId)
  const attachedQueued =
    queued !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || queued !== subscriber.queuePublication)
  if (journal) {
    event = subscriber.projectJournalEventSteps
      ? yield* subscriber.projectJournalEventSteps(
          journal,
          event,
          subscriber.queuePublication,
          queued,
          work
        )
      : (subscriber.projectJournalEvent?.(
          journal,
          event,
          subscriber.queuePublication,
          queued,
          work
        ) ?? event)
  }
  const backgroundTasks = subscriberBackgroundTasks(hooks, subscriber, event)
  const sideQueued = attachedQueued
    ? subscriber.projectQueuePublicationSteps
      ? yield* subscriber.projectQueuePublicationSteps(queued)
      : (subscriber.projectQueuePublication?.(queued) ?? queued)
    : undefined
  return {
    frames: subscriber.boundedFrames
      ? yield* mapAgentSessionSteps(
          yield* boundedFrameSteps(
            event,
            { queued: sideQueued, backgroundTasks },
            subscriber.cursor
          ),
          (frame, index) =>
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
    backgroundTasks: backgroundTasks === undefined ? undefined : JSON.stringify(backgroundTasks)
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
  options?: {
    withholdQueued?: boolean
    currentWork?: AgentSessionPublishedWork
    journal?: AgentSessionJournal
  }
): void {
  finishJournalSteps(emitSubscriberFrameSteps(hooks, subscriber, event, options))
}

export function* emitSubscriberFrameSteps(
  hooks: SubscriberFieldHooks,
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent,
  options?: {
    withholdQueued?: boolean
    currentWork?: AgentSessionPublishedWork
    journal?: AgentSessionJournal
  },
  current: () => boolean = () => true
): Generator<void, boolean> {
  const marker =
    event.type !== 'end' && subscriber.readsCurrentRequests
      ? options?.currentWork?.requestProjection(subscriber.sessionId).marker
      : undefined
  const includeMarker =
    marker && (event.type !== 'batch' || marker.version !== subscriber.requestVersion)
  const built = yield* buildSubscriberFrameSteps(
    hooks,
    subscriber,
    includeMarker && event.type !== 'end' ? { ...event, currentRequests: marker } : event,
    options?.withholdQueued === true,
    options?.currentWork,
    options?.journal
  )
  if (!current()) {
    return false
  }
  for (const outgoing of built.frames) {
    if (!current()) {
      return false
    }
    subscriber.emit(outgoing)
    yield
  }
  if (!current()) {
    return false
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
  return true
}

export function* safeSubscriberFrameSteps(
  hooks: SubscriberFieldHooks & {
    isCurrentJournal?: (id: string, journal: AgentSessionJournal) => boolean
    readCurrentWork?: SubscriberDeliveryPort['hooks']['readCurrentWork']
  },
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent,
  options: Parameters<SubscriberDeliveryPort['emit']>[2],
  active: (subscriber: Subscriber) => boolean,
  failed: () => void,
  superseded: () => void
): Generator<void, boolean> {
  const fence = subscriber.fence
  const reading = subscriber.cursor
  const journal = options?.journal
  const cursor = journal?.cursor()
  const stopRevision = journal?.stopMarks.revision()
  const work = options?.currentWork
  const currentWork = () => {
    const next = journal && hooks.readCurrentWork?.(subscriber.sessionId, journal)
    return (
      !work ||
      !hooks.readCurrentWork ||
      (work.viewKey() === next?.viewKey() && work.revision === next?.revision)
    )
  }
  const current = () =>
    active(subscriber) &&
    subscriber.fence === fence &&
    subscriber.cursor === reading &&
    (!journal ||
      (hooks.isCurrentJournal?.(subscriber.sessionId, journal) !== false &&
        cursor?.epoch === journal.cursor().epoch &&
        cursor?.sequence === journal.cursor().sequence &&
        stopRevision === journal.stopMarks.revision())) &&
    currentWork()
  try {
    const delivered = yield* emitSubscriberFrameSteps(hooks, subscriber, event, options, current)
    if (!delivered) {
      superseded()
      return false
    }
    if (options?.historyView !== undefined && current()) {
      subscriber.historyView = options.historyView
    }
    return true
  } catch {
    failed()
    return false
  }
}
