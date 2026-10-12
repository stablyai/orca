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

/** This handle's floor while no mark holds the pause (`AgentSessionJournal.reopenFloor`). */
export class QueuedMessageReopenFloor {
  private unmarked: AgentJournalCursor | null = null

  constructor(private readonly queue: Parameters<typeof queuedMessageReopenFloor>[0]) {}

  get = (): AgentJournalCursor | null => this.unmarked

  holdFromOpen(opened: AgentJournalCursor): void {
    this.unmarked = queuedMessageReopenFloor(this.queue, opened) ?? this.unmarked
  }

  /** Marks the reopen when a card waits or is mid-hand-off (it may come back to waiting); a failed
   *  write leaves `at`, where the mark would have gone, as the pause's start, and throws. */
  async mark(at: AgentJournalCursor, append: () => Promise<unknown>): Promise<void> {
    if (this.queue.awaitReopenMark()) {
      this.unmarked = at
      await append()
      this.unmarked = null
    }
  }
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
