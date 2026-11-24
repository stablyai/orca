import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
import type { AgentSessionPublishedWork } from '../../observations/agent-session-published-work'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { Subscriber } from './agent-session-subscribe-input'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { AgentSessionCommandDetailTuple } from '../../../../../shared/agent-session/background-tasks/agent-session-command-details'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import { boundedFrames } from '../history/agent-session-bounded-frames'
import { rememberSubscriberHostWork } from './agent-session-subscriber-live-text'
// Deduplicate against last sent values only; withheld fields must not suppress final replacements.

export type SubscriberFieldState = {
  commandsOnRequest?: boolean
  sessionId: string
  cursor?: AgentJournalCursor
  /** Every frame to fit a phone's bridge frame; see `boundedFrames`. */
  boundedFrames: boolean
  projectQueuePublication?: (publication: QueuePublication) => QueuePublication
  projectJournalEvent?: (
    journal: AgentSessionJournal,
    event: AgentSessionSubscribeEvent,
    previous: QueuePublication | undefined,
    current: QueuePublication | undefined,
    work?: AgentSessionPublishedWork
  ) => AgentSessionSubscribeEvent | Promise<AgentSessionSubscribeEvent>
  commands?: AgentSessionSlashCommand[] | null
  /** Deduplicate canonical state before reader-specific projection. */
  queuePublication?: QueuePublication
  backgroundTasks?: string
  /** This reader's audience projection, applied before fitting, fingerprint and comparison. */
  projectBackgroundTasks?: (
    state: AgentSessionBackgroundTaskState | null
  ) => AgentSessionBackgroundTaskState | null
  /** The last roster sent carried at least one exact-command tuple. Set only at emission. */
  detailCredit?: boolean
  /** That roster as sent (projected), kept while it holds credit. */
  creditedRoster?: AgentSessionBackgroundTaskState
  /** The fence on the frame that carried it. */
  creditedFence?: number
}

/** What a background-task lane entry sends, sampled in one synchronous host read when it runs. */
export type BackgroundTaskLaneRead =
  | { kind: 'roster'; fence: number; state: AgentSessionBackgroundTaskState | null }
  | {
      kind: 'availability'
      fence: number
      /** Re-checks credited tuples against current authority; never reopens the conversation. */
      keep: (tuples: readonly AgentSessionCommandDetailTuple[]) => AgentSessionCommandDetailTuple[]
    }

export type SubscriberFieldHooks = {
  readCommands?: (
    sessionId: string,
    commandsOnRequest?: boolean
  ) => AgentSessionSlashCommand[] | undefined
  /** `inLane`: read inside a held frame capture; never admits the lane itself. */
  readQueuePublication?: (
    sessionId: string,
    work?: StructuredAgentSessionObservedWork,
    inLane?: boolean
  ) => QueuePublication | null | undefined | Promise<QueuePublication | null | undefined>
  /** Read expensive child-derived rosters only when a frame owes them. */
  readBackgroundTasks?: (sessionId: string) => AgentSessionBackgroundTaskState | null
  /** The fence and roster (or, without a conversation, availability) a lane entry sends. */
  readBackgroundTaskLane?: (sessionId: string) => BackgroundTaskLaneRead | undefined
}

type SubscriberFrame = {
  /** Bounded subscribers receive side lists after history. */
  frames: AgentSessionSubscribeEvent[]
  /** Last observed inventory also deduplicates bounded command-change hints. */
  commands: AgentSessionSlashCommand[] | null | undefined
  attachedQueued: boolean
  queued: QueuePublication | undefined
  backgroundTasks: string | undefined
  backgroundTaskState: AgentSessionBackgroundTaskState | null | undefined
}

export function backgroundTaskFingerprint(state: AgentSessionBackgroundTaskState | null): string {
  return JSON.stringify(state)
}

/** Advance dedup references only after successful emission. */
async function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean,
  work?: AgentSessionPublishedWork,
  journal?: AgentSessionJournal,
  queuePublication?: { value: QueuePublication | undefined }
): Promise<SubscriberFrame> {
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
      : queuePublication
        ? queuePublication.value
        : ((await hooks.readQueuePublication?.(subscriber.sessionId)) ?? undefined)
  const attachedQueued =
    queued !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || queued !== subscriber.queuePublication)
  event = journal
    ? ((await subscriber.projectJournalEvent?.(
        journal,
        event,
        subscriber.queuePublication,
        queued,
        work
      )) ?? event)
    : event
  const backgroundTasks = subscriberBackgroundTasks(hooks, subscriber, event)
  const sideQueued = attachedQueued
    ? (subscriber.projectQueuePublication?.(queued) ?? queued)
    : undefined
  return {
    frames: subscriber.boundedFrames
      ? boundedFrames(event, { queued: sideQueued, backgroundTasks }, subscriber.cursor).map(
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
    backgroundTasks:
      backgroundTasks === undefined ? undefined : backgroundTaskFingerprint(backgroundTasks),
    backgroundTaskState: backgroundTasks
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
  const state =
    event.backgroundTasks !== undefined
      ? event.backgroundTasks
      : event.type !== 'batch' || subscriber.backgroundTasks === undefined
        ? hooks.readBackgroundTasks?.(subscriber.sessionId)
        : undefined
  return state === undefined || !subscriber.projectBackgroundTasks
    ? state
    : subscriber.projectBackgroundTasks(state)
}

/** Credit, the credited roster and its fence move together, only after a roster was sent. */
function recordDetailCredit(
  subscriber: SubscriberFieldState & { fence: number },
  state: AgentSessionBackgroundTaskState | null,
  fence: number
): void {
  if (state?.commandDetailsAvailable?.length) {
    subscriber.creditedRoster = state
    subscriber.detailCredit = true
    subscriber.creditedFence = fence
    return
  }
  subscriber.creditedRoster = undefined
  subscriber.detailCredit = false
  subscriber.creditedFence = undefined
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

/** Publication contains only a version; read completion supplies payload delivery credit. */
export async function emitSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent,
  options?: {
    withholdQueued?: boolean
    currentWork?: AgentSessionPublishedWork
    journal?: AgentSessionJournal
    queuePublication?: { value: QueuePublication | undefined }
    isActive?: () => boolean
  }
): Promise<void> {
  const marker =
    event.type !== 'end' && subscriber.readsCurrentRequests
      ? options?.currentWork?.requestProjection(subscriber.sessionId).marker
      : undefined
  const includeMarker =
    marker && (event.type !== 'batch' || marker.version !== subscriber.requestVersion)
  const built = await buildSubscriberFrame(
    hooks,
    subscriber,
    includeMarker && event.type !== 'end' ? { ...event, currentRequests: marker } : event,
    options?.withholdQueued === true,
    options?.currentWork,
    options?.journal,
    options?.queuePublication
  )
  if (options?.isActive && !options.isActive()) {
    return
  }
  for (const outgoing of built.frames) {
    if (options?.isActive && !options.isActive()) {
      return
    }
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
    // The one place credit is set, for every roster-bearing frame kind.
    if (built.backgroundTaskState !== undefined) {
      const fence = event.type !== 'end' ? (event.fence ?? subscriber.fence) : subscriber.fence
      recordDetailCredit(subscriber, built.backgroundTaskState, fence)
    }
  }
  rememberSubscriberHostWork(subscriber, event)
}
