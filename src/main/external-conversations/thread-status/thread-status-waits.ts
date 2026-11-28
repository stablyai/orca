// What a thread's lines wait on that only this process sees: prompts shown in the thread, and a
// pane's turn that just ended, whose answer is still being read, posted or queued.
import type { ThreadLineNotes } from './thread-status-lines'
import { idOf } from './thread-status-deps'

// After a pane's turn ends its answer is read, posted or queued, and its workers read: lines wait.
const TURN_END_SETTLE_MS = 2 * 60_000

export class ThreadStatusWaits {
  // Open prompts each armed conversation showed, by conversation id.
  private readonly prompts = new Map<string, Set<string>>()
  // The link and turn each thread's latest answer read found nothing unsent for, and when it began.
  private readonly answerClear = new Map<string, { key: string; at: number }>()
  // Panes whose turn just ended, until when their lines wait for its answer.
  private readonly settling = new Map<string, number>()
  // When each pane's latest turn ended, as told: a read begun before it is for an older turn.
  private readonly endedAt = new Map<string, number>()
  // The line each thread saved in this process and has not handed to the cloud yet: the one saved
  // line known to be absent from the thread.
  private readonly unsent = new Map<string, string>()

  constructor(private readonly now: () => number) {}

  /** A batch's turn ends close every prompt before them; `armed` says which threads keep new ones. */
  noted(notes: ThreadLineNotes, armed: (id: string) => boolean): void {
    for (const conversation of notes.turnEnds) {
      this.prompts.delete(idOf(conversation))
    }
    for (const { conversation, promptId, open } of notes.prompts) {
      const id = idOf(conversation)
      if (open && armed(id)) {
        this.prompts.set(id, (this.prompts.get(id) ?? new Set()).add(promptId))
      } else if (!open) {
        this.prompts.get(id)?.delete(promptId)
      }
    }
  }

  promptOpen(id: string): boolean {
    return (this.prompts.get(id)?.size ?? 0) > 0
  }

  turnEnding(paneKey: string): void {
    this.settling.set(paneKey, this.now() + TURN_END_SETTLE_MS)
    this.endedAt.set(paneKey, this.now())
  }

  settlingNow(paneKey: string): boolean {
    const until = this.settling.get(paneKey)
    if (until !== undefined && until <= this.now()) {
      this.settling.delete(paneKey)
    }
    return until !== undefined && until > this.now()
  }

  /** `key`: the link and turn a read begun at `at` found clear; null when it held the line. */
  answerRead(id: string, key: string | null, at: number): void {
    if (key === null) {
      this.answerClear.delete(id)
    } else {
      this.answerClear.set(id, { key, at })
    }
  }

  /** The latest read found this link and turn clear, and no turn of the pane ended since it began. */
  answerClearFor(id: string, key: string, paneKey: string): boolean {
    const read = this.answerClear.get(id)
    const ended = this.endedAt.get(paneKey)
    return read?.key === key && (ended === undefined || ended < read.at)
  }

  /** A line saved, not yet sent; `sending` once it goes to the cloud, whatever its answer. */
  saved(id: string, replyId: string): void {
    this.unsent.set(id, replyId)
  }

  sending(id: string): void {
    this.unsent.delete(id)
  }

  /** Whether a saved line may already be in the thread: any but one this process kept unsent. A
   *  line saved before a restart, or by an older Orca, may have gone out with no answer seen. */
  mayHavePosted(id: string, replyId: string | undefined): boolean {
    return replyId !== undefined && this.unsent.get(id) !== replyId
  }

  forgetThread(id: string): void {
    this.prompts.delete(id)
    this.answerClear.delete(id)
    this.unsent.delete(id)
  }

  forgetPane(paneKey: string): void {
    this.settling.delete(paneKey)
    this.endedAt.delete(paneKey)
  }
}
