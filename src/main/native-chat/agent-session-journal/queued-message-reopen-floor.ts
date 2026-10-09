// Where a reopened chat's queue pause starts before any reopen mark is written: derived from where
// the conversation's handle opened, so nothing has to land first (`queued-message-pause.ts`).

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { DerivedQueuePause } from './queued-message-pause'

/** Just past `opened` when a card waits for a reopen mark and no earlier mark holds it already;
 *  null otherwise. */
export function queuedMessageReopenFloor(
  queue: { awaitReopenMark: () => boolean; pauses: () => readonly DerivedQueuePause[] },
  opened: AgentJournalCursor
): AgentJournalCursor | null {
  return queue.awaitReopenMark() && !queue.pauses().some((pause) => pause.reason === 'restarted')
    ? { epoch: opened.epoch, sequence: opened.sequence + 1 }
    : null
}

/** Where the reopen mark of what an earlier host process left starts: this handle's unmarked
 *  floor, else just past where this process first opened the chat; null when neither is in the
 *  journal's current epoch, since a mark from now would hold cards this process queued since. */
export function queuedMessageReopenMarkStart(
  floor: AgentJournalCursor | null,
  processOpened: AgentJournalCursor,
  epoch: string
): number | null {
  if (floor?.epoch === epoch) {
    return floor.sequence
  }
  return processOpened.epoch === epoch ? processOpened.sequence + 1 : null
}
