import { mapAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
import {
  finishJournalSteps,
  sortJournalSteps
} from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import {
  agentSessionPublishedWorkFieldSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import { sourceIdSteps, sourceItem, sourcePresentation } from './agent-session-queued-image-reader'
/** Only queue/source semantic changes correct rows; work and pause never replay the population. */
export function queuedImageReaderEvent(
  journal: AgentSessionJournal,
  event: AgentSessionSubscribeEvent,
  previous: QueuePublication | undefined,
  current: QueuePublication | undefined,
  work?: AgentSessionPublishedWork
): AgentSessionSubscribeEvent {
  return finishJournalSteps(queuedImageReaderEventSteps(journal, event, previous, current, work))
}

export function* queuedImageReaderEventSteps(
  journal: AgentSessionJournal,
  event: AgentSessionSubscribeEvent,
  previous: QueuePublication | undefined,
  current: QueuePublication | undefined,
  work?: AgentSessionPublishedWork
): Generator<void, AgentSessionSubscribeEvent> {
  if (!current || event.type !== 'batch') {
    return event
  }
  const { ids: now, imageIds } = yield* sourceIdSteps(journal, current.queuedMessages)
  const before = (yield* sourceIdSteps(journal, previous?.queuedMessages ?? [])).ids
  if (
    before === now &&
    !event.batch.submissions.some(
      (send) => now.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
    )
  ) {
    return event
  }
  const changed = new Set<string>()
  for (const id of before === now ? [] : combinedIds(before, now)) {
    if (before.get(id) !== now.get(id)) {
      changed.add(id)
    }
    yield
  }
  for (const send of event.batch.submissions) {
    if (
      now.has(send.clientMessageId) ||
      before.has(send.clientMessageId) ||
      imageIds.has(send.queuedMessageId ?? '')
    ) {
      changed.add(send.clientMessageId)
    }
  }
  if (changed.size === 0) {
    return event
  }
  const items = new Map(event.batch.items.map((item) => [item.itemId, item]))
  const removed = new Set(event.batch.removedItemIds)
  const submissions = new Map(event.batch.submissions.map((send) => [send.clientMessageId, send]))
  for (const id of changed) {
    yield
    const key = agentJournalSubmissionKey(id)
    const original = submissions.get(id) ?? journal.submission(id)
    const send = original && work ? work.publishedSubmission(original) : original
    const active = now.get(id) === true && send?.dispatchState !== 'accepted'
    if (!journal.item(key) && (before.get(id) === true) !== active) {
      const item = active ? sourceItem(journal, id) : null
      if (item) {
        items.set(key, boundedFrameItem(agentJournalItemForWire(item)).item)
        removed.delete(key)
      } else {
        items.delete(key)
        removed.add(key)
      }
    }
    if (send) {
      submissions.set(
        id,
        now.has(id) || imageIds.has(send.queuedMessageId ?? '')
          ? sourcePresentation(send, now.get(id) === true)
          : send
      )
    }
  }
  return {
    ...event,
    ...(work ? yield* agentSessionPublishedWorkFieldSteps(journal, work) : {}),
    batch: {
      ...event.batch,
      items: yield* sortJournalSteps(items.values(), compareAgentJournalItems),
      removedItemIds: yield* mapAgentSessionSteps(removed, (id) => id),
      submissions: yield* mapAgentSessionSteps(submissions.values(), (send) => send)
    }
  }
}

function* combinedIds(
  before: ReadonlyMap<string, boolean>,
  now: ReadonlyMap<string, boolean>
): Generator<string> {
  yield* before.keys()
  yield* now.keys()
}
