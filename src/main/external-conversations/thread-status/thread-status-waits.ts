// What a thread's lines wait on that only this process sees: prompts shown in the thread, and a
// pane's turn that just ended, whose answer is still being read, posted or queued.
import type { ThreadLineNotes } from './thread-status-lines'
import { idOf } from './thread-status-deps'

// After a pane's turn ends its answer is read, posted or queued, and its workers read: lines wait.
const TURN_END_SETTLE_MS = 2 * 60_000

export class ThreadStatusWaits {
  // Open prompts each armed conversation showed, by conversation id.
  private readonly prompts = new Map<string, Set<string>>()
  // Panes whose turn just ended, until when their lines wait for its answer.
  private readonly settling = new Map<string, number>()

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
  }

  settlingNow(paneKey: string): boolean {
    const until = this.settling.get(paneKey)
    if (until !== undefined && until <= this.now()) {
      this.settling.delete(paneKey)
    }
    return until !== undefined && until > this.now()
  }

  forgetThread(id: string): void {
    this.prompts.delete(id)
  }

  forgetPane(paneKey: string): void {
    this.settling.delete(paneKey)
  }
}
