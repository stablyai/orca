// Which per-emit fields ride one subscriber frame: the provider command catalog
// and the queue publication (the draft list with the queue's pause). Both are
// identity-deduplicated against the LAST VALUE SENT — never advanced on a frame
// that withheld the field, or the final replacement would be suppressed — and
// both attach whole to hydrating frames.

import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import {
  nativeChatAsyncQuestionsFieldBytes,
  type NativeChatAsyncQuestionsField
} from '../../../shared/native-chat-async-questions'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type SubscriberFieldState = {
  sessionId: string
  commands?: AgentSessionSlashCommand[] | null
  /** The last queue publication actually SENT. */
  queuePublication?: QueuePublication
  /** The last pending async-question set actually SENT. */
  asyncQuestions?: NativeChatAsyncQuestionsField
}

export type SubscriberFieldHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  /** Host-derived from the whole journal, so it never depends on the page a client holds. */
  readAsyncQuestions?: (
    sessionId: string,
    journal: AgentSessionJournal
  ) => NativeChatAsyncQuestionsField | undefined
}

export type SubscriberFrame = {
  frame: AgentSessionSubscribeEvent
  commands: AgentSessionSlashCommand[] | null
  attachedQueued: boolean
  queued: QueuePublication | undefined
  /** Set when this frame carries the async-question set. */
  asyncQuestions: NativeChatAsyncQuestionsField | undefined
}

// The published field is identity-stable while the set is unchanged, so its size is measured once.
const fieldBytes = new WeakMap<NativeChatAsyncQuestionsField, number>()

/** Bytes the async-question field takes from a frame's history page: its actual size, since
 *  only these frames carry it (other pages keep the whole budget). */
export function asyncQuestionsFrameReserveBytes(
  hooks: SubscriberFieldHooks,
  sessionId: string,
  journal: AgentSessionJournal
): number {
  const field = hooks.readAsyncQuestions?.(sessionId, journal)
  if (!field) {
    return 0
  }
  let bytes = fieldBytes.get(field)
  if (bytes === undefined) {
    bytes = nativeChatAsyncQuestionsFieldBytes(field)
    fieldBytes.set(field, bytes)
  }
  return bytes
}

/** Builds the frame to emit; the caller stores the returned refs only after the
 *  emit succeeded, so a dropped subscriber never advances its dedup state. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean,
  journal?: AgentSessionJournal
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
  // Rides with the queue publication: whole on hydration, on batches only when it changed. A
  // subscription's first frame always carries it, even mid catch-up: a resumed client reads its
  // absence there as a host that never publishes it.
  const firstPublication = subscriber.asyncQuestions === undefined
  const asyncQuestions =
    (withholdQueued && !firstPublication) || !journal || event.type === 'end'
      ? undefined
      : hooks.readAsyncQuestions?.(subscriber.sessionId, journal)
  const attachedAsync =
    asyncQuestions !== undefined &&
    (event.type !== 'batch' || asyncQuestions !== subscriber.asyncQuestions)
  return {
    frame: {
      ...event,
      ...(includeCommands ? { commands: commands ?? null } : {}),
      ...(attachedQueued && queued
        ? { queuedMessages: queued.queuedMessages, queuePause: queued.queuePause }
        : {}),
      ...(attachedAsync ? { asyncQuestions } : {})
    },
    commands,
    attachedQueued,
    queued,
    asyncQuestions: attachedAsync ? asyncQuestions : undefined
  }
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
